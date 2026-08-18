const fs = require("node:fs");
const { spawn: defaultSpawn } = require("node:child_process");
const {
  TOKEN_FIELDS,
  cloneTokens,
  createIncrementalTranscriptParser,
  emptyCapabilityUsage,
  emptyTokens,
  normalizeCapabilityUsage,
  parseTranscriptFile,
  parseTranscriptText,
  safeInteger
} = require("./agent-token-transcript.cjs");
const { subtractCapabilities } = require("../stores/agent-token-stats-store.cjs");
const { toWslHostPath } = require("./remote-file-service.cjs");

const RETRY_DELAYS_MS = [150, 500, 1200];
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const LIVE_POLL_INTERVAL_MS = 1000;
const TOKEN_STATS_PROVIDERS = ["codex", "claude", "codebuddy"];
const LIVE_TOKEN_PROVIDERS = ["codex", "claude", "codebuddy"];

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function remoteParserCommand(provider, transcriptPath) {
  const script = `import json,sys\np=sys.argv[1]; f=sys.argv[2]; lines=open(f,'r',encoding='utf-8').read().splitlines(); print(json.dumps(lines))`;
  return `python3 -c ${shellQuote(script)} ${shellQuote(provider)} ${shellQuote(transcriptPath)}`;
}

function runProcess(command, args, spawn = defaultSpawn) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf-8");
      if (Buffer.byteLength(stdout, "utf-8") > MAX_TRANSCRIPT_BYTES) child.kill();
    });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf-8"); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `Transcript reader exited with code ${code}.`)));
  });
}

function runSsh(sessionId, command, sshSessionRuntime) {
  return sshSessionRuntime.connectClient(sessionId, { actionName: "Agent token statistics", timeoutMs: 10000 })
    .then(client => new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) { client.end(); reject(error); return; }
        let stdout = "";
        let stderr = "";
        stream.on("data", chunk => { stdout += chunk.toString("utf-8"); });
        stream.stderr?.on("data", chunk => { stderr += chunk.toString("utf-8"); });
        stream.on("close", code => {
          client.end();
          if (code === 0) resolve(stdout); else reject(new Error(stderr.trim() || `Remote transcript reader exited with code ${code}.`));
        });
      });
    }));
}

function subtractTokens(current, baseline) {
  return Object.fromEntries(TOKEN_FIELDS.map(field => [field, Math.max(0, safeInteger(current?.[field]) - safeInteger(baseline?.[field]))]));
}

function createAgentTokenStatsService({
  terminalManager,
  statsStore,
  sshSessionRuntime,
  broadcast = () => {},
  spawn = defaultSpawn,
  now = () => Date.now(),
  retryDelaysMs = RETRY_DELAYS_MS,
  pollIntervalMs = LIVE_POLL_INTERVAL_MS,
  fsPromises = fs.promises,
  toWslHostPathFn = toWslHostPath,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
}) {
  const pending = new Map();
  const baselinePending = new Map();
  const startedAtBySession = new Map();
  const liveTrackers = new Map();
  const remoteSnapshots = new Map();

  async function parseRemote(session, provider, transcriptPath) {
    const command = remoteParserCommand(provider, transcriptPath);
    const output = session.type === "wsl"
      ? await runProcess("wsl.exe", ["-d", session.wslDistro, "--", "bash", "-lc", command], spawn)
      : await runSsh(session.id, command, sshSessionRuntime);
    const lines = JSON.parse(output);
    return parseTranscriptText(provider, Array.isArray(lines) ? lines.join("\n") : "");
  }

  async function readWithRetry(session, provider, transcriptPath) {
    let lastError;
    for (const delay of retryDelaysMs) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        return session.type === "windows"
          ? parseTranscriptFile(provider, transcriptPath)
          : await parseRemote(session, provider, transcriptPath);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  function collect({ provider, input, session }) {
    if (!TOKEN_STATS_PROVIDERS.includes(provider) || !session || !input) return;
    const agentSessionId = input.session_id || input.sessionId;
    const transcriptPath = input.transcript_path || input.transcriptPath;
    if (!agentSessionId || !transcriptPath) return;
    const key = `${provider}:${agentSessionId}`;
    const request = Promise.resolve(baselinePending.get(key))
      .catch(() => undefined)
      .then(() => readWithRetry(session, provider, transcriptPath))
      .then(result => {
        const record = statsStore.update({
          provider,
          agentSessionId,
          panelSessionId: session.id,
          templateId: session.templateId,
          title: session.title,
          cwd: input.cwd || session.cwd,
          location: session.type,
          models: result.models.length ? result.models : [input.model].filter(Boolean),
          tokens: result.tokens,
          capabilities: result.capabilities,
          startedAt: startedAtBySession.get(key)
        });
        if (session.type === "ssh" && record) {
          const snapshot = {
            panelSessionId: session.id,
            provider,
            state: "completed",
            tokens: cloneTokens(record.tokens),
            capabilities: normalizeCapabilityUsage(record.capabilities),
            turnOutputTokens: 0,
            outputTokensPerSecond: 0,
            models: [...record.models],
            updatedAt: now()
          };
          remoteSnapshots.set(session.id, snapshot);
          broadcast("agent-token-live:changed", snapshot);
        }
        return record;
      })
      .catch(error => console.error(`Failed to collect ${provider} token statistics:`, error))
      .finally(() => { if (pending.get(key) === request) pending.delete(key); });
    pending.set(key, request);
  }

  function captureBaseline({ provider, input, session }) {
    const agentSessionId = input.session_id || input.sessionId;
    const transcriptPath = input.transcript_path || input.transcriptPath;
    if (!agentSessionId || !transcriptPath) return;
    const key = `${provider}:${agentSessionId}`;
    if (baselinePending.has(key)) return;
    const request = (session.type === "windows"
      ? Promise.resolve().then(() => parseTranscriptFile(provider, transcriptPath))
      : parseRemote(session, provider, transcriptPath))
      .then(result => statsStore.setBaseline(provider, agentSessionId, result.tokens, result.capabilities))
      .catch(() => statsStore.setBaseline(provider, agentSessionId, {}, emptyCapabilityUsage()));
    baselinePending.set(key, request);
  }

  function getLiveHostPath(session, transcriptPath) {
    if (session.type === "windows") return transcriptPath;
    if (session.type === "wsl") return toWslHostPathFn(session.wslDistro, transcriptPath);
    return null;
  }

  function resetLiveReader(tracker) {
    tracker.offset = 0;
    tracker.pendingBytes = Buffer.alloc(0);
    tracker.parser = createIncrementalTranscriptParser(tracker.provider);
  }

  function ensureLiveTracker({ provider, input, session }) {
    if (!LIVE_TOKEN_PROVIDERS.includes(provider) || !["windows", "wsl"].includes(session?.type)) return null;
    const agentSessionId = input?.session_id || input?.sessionId;
    const transcriptPath = input?.transcript_path || input?.transcriptPath;
    if (!agentSessionId || !transcriptPath) return null;
    const hostPath = getLiveHostPath(session, transcriptPath);
    let tracker = liveTrackers.get(session.id);
    if (!tracker || tracker.provider !== provider || tracker.agentSessionId !== agentSessionId || tracker.hostPath !== hostPath) {
      if (tracker?.timer) clearIntervalFn(tracker.timer);
      tracker = {
        panelSessionId: session.id,
        agentSessionId,
        provider,
        hostPath,
        fileIdentity: null,
        offset: 0,
        pendingBytes: Buffer.alloc(0),
        parser: createIncrementalTranscriptParser(provider),
        rawTokens: emptyTokens(),
        rawCapabilities: emptyCapabilityUsage(),
        sessionBaseline: null,
        sessionCapabilityBaseline: null,
        turnBaseline: emptyTokens(),
        turnStartedAt: null,
        state: "waiting",
        models: [],
        updatedAt: now(),
        outputTokensPerSecond: 0,
        timer: null,
        pollPromise: null
      };
      liveTrackers.set(session.id, tracker);
    }
    return tracker;
  }

  function buildLiveSnapshot(tracker) {
    const tokens = subtractTokens(tracker.rawTokens, tracker.sessionBaseline || emptyTokens());
    const capabilities = subtractCapabilities(tracker.rawCapabilities, tracker.sessionCapabilityBaseline || emptyCapabilityUsage());
    const turnOutputTokens = Math.max(0, tokens.outputTokens - safeInteger(tracker.turnBaseline?.outputTokens));
    return {
      panelSessionId: tracker.panelSessionId,
      provider: tracker.provider,
      state: tracker.state,
      tokens,
      capabilities,
      turnOutputTokens,
      outputTokensPerSecond: tracker.outputTokensPerSecond,
      models: [...tracker.models],
      updatedAt: tracker.updatedAt
    };
  }

  function emitLive(tracker) {
    const snapshot = buildLiveSnapshot(tracker);
    broadcast("agent-token-live:changed", snapshot);
    return snapshot;
  }

  async function readAppendedBytes(tracker) {
    const stat = await fsPromises.stat(tracker.hostPath);
    if (stat.size > MAX_TRANSCRIPT_BYTES) throw new Error("Agent transcript exceeds the live monitoring size limit.");
    const fileIdentity = `${stat.dev ?? ""}:${stat.ino ?? ""}:${stat.birthtimeMs ?? ""}`;
    if (tracker.fileIdentity !== null && tracker.fileIdentity !== fileIdentity) resetLiveReader(tracker);
    tracker.fileIdentity = fileIdentity;
    if (stat.size < tracker.offset) resetLiveReader(tracker);
    if (stat.size === tracker.offset) return false;
    const length = stat.size - tracker.offset;
    const handle = await fsPromises.open(tracker.hostPath, "r");
    let bytesRead = 0;
    const buffer = Buffer.alloc(length);
    try {
      while (bytesRead < length) {
        const result = await handle.read(buffer, bytesRead, length - bytesRead, tracker.offset + bytesRead);
        if (!result.bytesRead) break;
        bytesRead += result.bytesRead;
      }
    } finally {
      await handle.close();
    }
    tracker.offset += bytesRead;
    const combined = Buffer.concat([tracker.pendingBytes, buffer.subarray(0, bytesRead)]);
    let lineStart = 0;
    let parsedUsage = false;
    for (let index = 0; index < combined.length; index += 1) {
      if (combined[index] !== 0x0a) continue;
      let line = combined.subarray(lineStart, index);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length) parsedUsage = tracker.parser.pushLine(line.toString("utf-8")) || parsedUsage;
      lineStart = index + 1;
    }
    tracker.pendingBytes = combined.subarray(lineStart);
    return parsedUsage;
  }

  async function pollLive(tracker, { emit = true } = {}) {
    if (tracker.pollPromise) return tracker.pollPromise;
    const request = readAppendedBytes(tracker)
      .then(() => {
        const result = tracker.parser.getResult();
        if (result) {
          if (tracker.state === "unavailable") {
            tracker.state = tracker.turnStartedAt ? (tracker.timer ? "generating" : "completed") : "waiting";
          }
          tracker.rawTokens = cloneTokens(result.tokens);
          tracker.rawCapabilities = normalizeCapabilityUsage(result.capabilities);
          tracker.models = result.models;
          if (!tracker.sessionBaseline) tracker.sessionBaseline = cloneTokens(result.tokens);
          if (!tracker.sessionCapabilityBaseline) tracker.sessionCapabilityBaseline = normalizeCapabilityUsage(result.capabilities);
          if (tracker.state === "generating" && tracker.turnStartedAt) {
            const visible = subtractTokens(tracker.rawTokens, tracker.sessionBaseline);
            const turnOutput = Math.max(0, visible.outputTokens - safeInteger(tracker.turnBaseline?.outputTokens));
            const elapsedSeconds = Math.max(0.001, (now() - tracker.turnStartedAt) / 1000);
            tracker.outputTokensPerSecond = Math.round((turnOutput / elapsedSeconds) * 10) / 10;
          }
          tracker.updatedAt = now();
        }
        if (emit) emitLive(tracker);
        return result;
      })
      .catch(() => {
        tracker.state = "unavailable";
        tracker.updatedAt = now();
        if (emit) emitLive(tracker);
        return null;
      })
      .finally(() => { if (tracker.pollPromise === request) tracker.pollPromise = null; });
    tracker.pollPromise = request;
    return request;
  }

  function stopLiveTimer(tracker) {
    if (!tracker?.timer) return;
    clearIntervalFn(tracker.timer);
    tracker.timer = null;
  }

  function startLiveTimer(tracker) {
    stopLiveTimer(tracker);
    tracker.timer = setIntervalFn(() => { void pollLive(tracker); }, pollIntervalMs);
  }

  async function startLiveTurn(tracker) {
    await pollLive(tracker, { emit: false });
    if (!tracker.sessionBaseline) tracker.sessionBaseline = cloneTokens(tracker.rawTokens);
    if (!tracker.sessionCapabilityBaseline) tracker.sessionCapabilityBaseline = normalizeCapabilityUsage(tracker.rawCapabilities);
    const visible = subtractTokens(tracker.rawTokens, tracker.sessionBaseline);
    tracker.turnBaseline = cloneTokens(visible);
    tracker.turnStartedAt = now();
    tracker.outputTokensPerSecond = 0;
    tracker.state = "generating";
    tracker.updatedAt = now();
    emitLive(tracker);
    startLiveTimer(tracker);
  }

  async function completeLiveTurn(tracker) {
    await pollLive(tracker, { emit: false });
    if (tracker.pendingBytes.length && tracker.parser.pushLine(tracker.pendingBytes.toString("utf-8"))) {
      const result = tracker.parser.getResult();
      tracker.rawTokens = cloneTokens(result?.tokens || tracker.rawTokens);
      tracker.models = result?.models || tracker.models;
      tracker.pendingBytes = Buffer.alloc(0);
    }
    if (tracker.turnStartedAt) {
      const visible = subtractTokens(tracker.rawTokens, tracker.sessionBaseline || emptyTokens());
      const turnOutput = Math.max(0, visible.outputTokens - safeInteger(tracker.turnBaseline?.outputTokens));
      const elapsedSeconds = Math.max(0.001, (now() - tracker.turnStartedAt) / 1000);
      tracker.outputTokensPerSecond = Math.round((turnOutput / elapsedSeconds) * 10) / 10;
    }
    tracker.state = "completed";
    tracker.updatedAt = now();
    stopLiveTimer(tracker);
    emitLive(tracker);
  }

  return {
    handleHook({ provider, input, session }) {
      const eventName = input?.hook_event_name || input?.eventName || input?.event_name;
      const agentSessionId = input?.session_id || input?.sessionId;
      if (TOKEN_STATS_PROVIDERS.includes(provider) && agentSessionId) {
        const key = `${provider}:${agentSessionId}`;
        if (!startedAtBySession.has(key)) startedAtBySession.set(key, now());
        if (eventName === "SessionStart" || eventName === "UserPromptSubmit") captureBaseline({ provider, input, session });
      }

      const tracker = ensureLiveTracker({ provider, input, session });
      if (tracker && eventName === "SessionStart") void pollLive(tracker);
      if (tracker && eventName === "UserPromptSubmit") void startLiveTurn(tracker);
      if (tracker && eventName === "Stop") void completeLiveTurn(tracker);

      if (eventName === "Stop" || eventName === "SessionEnd") collect({ provider, input, session });
    },
    getLive(panelSessionId) {
      const tracker = liveTrackers.get(String(panelSessionId || ""));
      return tracker ? buildLiveSnapshot(tracker) : remoteSnapshots.get(String(panelSessionId || "")) || null;
    },
    markEnded(panelSessionId) {
      const tracker = liveTrackers.get(panelSessionId);
      stopLiveTimer(tracker);
      liveTrackers.delete(panelSessionId);
      remoteSnapshots.delete(panelSessionId);
      statsStore.markEnded(panelSessionId);
    },
    shutdown() {
      for (const tracker of liveTrackers.values()) stopLiveTimer(tracker);
      liveTrackers.clear();
      remoteSnapshots.clear();
    }
  };
}

module.exports = {
  LIVE_POLL_INTERVAL_MS,
  createAgentTokenStatsService,
  remoteParserCommand,
  shellQuote,
  subtractTokens
};
