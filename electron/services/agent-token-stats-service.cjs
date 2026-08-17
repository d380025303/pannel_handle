const { spawn: defaultSpawn } = require("node:child_process");
const { parseTranscriptFile, parseTranscriptText } = require("./agent-token-transcript.cjs");

const RETRY_DELAYS_MS = [150, 500, 1200];
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

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

function createAgentTokenStatsService({ terminalManager, statsStore, sshSessionRuntime, spawn = defaultSpawn }) {
  const pending = new Map();
  const baselinePending = new Map();
  const startedAtBySession = new Map();

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
    for (const delay of RETRY_DELAYS_MS) {
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
    if (!['codex', 'claude'].includes(provider) || !session || !input) return;
    const agentSessionId = input.session_id || input.sessionId;
    const transcriptPath = input.transcript_path || input.transcriptPath;
    if (!agentSessionId || !transcriptPath) return;
    const key = `${provider}:${agentSessionId}`;
    const request = Promise.resolve(baselinePending.get(key))
      .catch(() => undefined)
      .then(() => readWithRetry(session, provider, transcriptPath))
      .then(result => statsStore.update({
        provider,
        agentSessionId,
        panelSessionId: session.id,
        templateId: session.templateId,
        title: session.title,
        cwd: input.cwd || session.cwd,
        location: session.type,
        models: result.models.length ? result.models : [input.model].filter(Boolean),
        tokens: result.tokens,
        startedAt: startedAtBySession.get(key)
      }))
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
      .then(result => statsStore.setBaseline(provider, agentSessionId, result.tokens))
      .catch(() => statsStore.setBaseline(provider, agentSessionId, {}));
    baselinePending.set(key, request);
  }

  return {
    handleHook({ provider, input, session }) {
      const eventName = input?.hook_event_name || input?.eventName || input?.event_name;
      const agentSessionId = input?.session_id || input?.sessionId;
      if (['codex', 'claude'].includes(provider) && agentSessionId) {
        const key = `${provider}:${agentSessionId}`;
        if (!startedAtBySession.has(key)) startedAtBySession.set(key, Date.now());
        if (eventName === "SessionStart" || eventName === "UserPromptSubmit") captureBaseline({ provider, input, session });
      }
      if (eventName === "Stop" || eventName === "SessionEnd") collect({ provider, input, session });
    },
    markEnded: panelSessionId => statsStore.markEnded(panelSessionId)
  };
}

module.exports = { createAgentTokenStatsService, remoteParserCommand, shellQuote };
