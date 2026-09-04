const fs = require("node:fs");
const path = require("node:path");
const {
  createIncrementalTranscriptParser,
  getCodeBuddySubagentsDir
} = require("../agent-token-transcript.cjs");
const { createCopilotOtelParser, getCopilotOtelPath } = require("../copilot-otel.cjs");

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const REMOTE_DELTA_SCRIPT = [
  "import base64,glob,json,os,sys",
  "f=sys.argv[1]; state=json.loads(sys.argv[2]); limit=int(sys.argv[3])",
  "def read_delta(p):",
  " st=os.stat(p)",
  " if st.st_size>limit: raise ValueError('Agent transcript exceeds the live monitoring size limit.')",
  " ident=f'{st.st_dev}:{st.st_ino}'",
  " prev=state.get(p,{})",
  " off=int(prev.get('offset',0) or 0)",
  " if prev.get('identity')!=ident or st.st_size<off: off=0",
  " with open(p,'rb') as h:",
  "  h.seek(off); data=h.read()",
  " return {'path':p,'identity':ident,'start':off,'offset':off+len(data),'data':base64.b64encode(data).decode('ascii')}",
  "result={'main':read_delta(f),'subagents':[]}",
  "d=os.path.join(os.path.dirname(f),os.path.splitext(os.path.basename(f))[0],'subagents')",
  "for p in sorted(glob.glob(os.path.join(d,'*.jsonl'))):",
  " try: result['subagents'].append(read_delta(p))",
  " except Exception: pass",
  "print(json.dumps(result,separators=(',',':')))"
].join("\n");

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function remoteDeltaCommand(transcriptPath, readerState) {
  return `python3 -c ${shellQuote(REMOTE_DELTA_SCRIPT)} ${shellQuote(transcriptPath)} ${shellQuote(JSON.stringify(readerState))} ${MAX_TRANSCRIPT_BYTES}`;
}

function runSshClientCommand(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) { reject(error); return; }
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve(value);
      };
      stream.on("data", chunk => {
        stdout += chunk.toString("utf-8");
        if (Buffer.byteLength(stdout, "utf-8") > Math.ceil(MAX_TRANSCRIPT_BYTES * 4 / 3) + 1024 * 1024) {
          stream.close?.();
          finish(new Error("Remote transcript delta exceeds the live monitoring size limit."));
        }
      });
      stream.stderr?.on("data", chunk => { stderr += chunk.toString("utf-8"); });
      stream.once?.("error", finish);
      stream.on("close", code => {
        if (code === 0) finish(null, stdout);
        else finish(new Error(stderr.trim() || `Remote transcript reader exited with code ${code}.`));
      });
    });
  });
}

function createTranscriptSource({
  sshSessionRuntime,
  fsPromises = fs.promises,
  toWslHostPath,
  onMainLine = () => {},
  onReset = () => {}
}) {
  function isLocalSshBridge(session) {
    return session?.type === "ssh" && session.agentLocation === "local";
  }

  function isRemoteCodeBuddy(session, provider) {
    return provider === "codebuddy" && session?.type === "ssh" && !isLocalSshBridge(session);
  }

  function hasHostReadableTranscript(session) {
    return session?.type === "windows" || session?.type === "wsl" || isLocalSshBridge(session);
  }

  function getLiveHostPath(session, transcriptPath) {
    if (session.type === "windows" || isLocalSshBridge(session)) return transcriptPath;
    if (session.type === "wsl") return toWslHostPath(session.wslDistro, transcriptPath);
    return null;
  }

  function resolveTrackerSource(provider, input, session) {
    const remote = isRemoteCodeBuddy(session, provider);
    if (!hasHostReadableTranscript(session) && !remote) return null;
    const transcriptPath = provider === "copilot"
      ? getCopilotOtelPath(session)
      : input?.transcript_path || input?.transcriptPath;
    if (!transcriptPath) return null;
    return {
      hostPath: remote ? transcriptPath : getLiveHostPath(session, transcriptPath),
      remote
    };
  }

  function createParser(provider) {
    return provider === "copilot" ? createCopilotOtelParser() : createIncrementalTranscriptParser(provider);
  }

  function closeRemoteClient(tracker) {
    if (!tracker?.remote) return;
    const client = tracker.remoteClient;
    const pendingClient = tracker.remoteClientPromise;
    tracker.remoteClient = null;
    tracker.remoteClientPromise = null;
    try { client?.end?.(); } catch { /* Ignore SSH cleanup failures. */ }
    if (!client && pendingClient) {
      void pendingClient.then(connected => {
        try { connected?.end?.(); } catch { /* Ignore SSH cleanup failures. */ }
      }).catch(() => undefined);
    }
  }

  function reset(tracker) {
    tracker.offset = 0;
    tracker.pendingBytes = Buffer.alloc(0);
    tracker.parser = createParser(tracker.provider);
    for (const reader of tracker.subagentReaders?.values() || []) {
      reader.offset = 0;
      reader.pendingBytes = Buffer.alloc(0);
    }
    onReset(tracker);
  }

  function consumeMainBytes(tracker, buffer) {
    const combined = Buffer.concat([tracker.pendingBytes, buffer]);
    let lineStart = 0;
    let parsedUsage = false;
    for (let index = 0; index < combined.length; index += 1) {
      if (combined[index] !== 0x0a) continue;
      let line = combined.subarray(lineStart, index);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length) {
        const text = line.toString("utf-8");
        parsedUsage = tracker.parser.pushLine(text) || parsedUsage;
        onMainLine(tracker, text);
      }
      lineStart = index + 1;
    }
    tracker.pendingBytes = combined.subarray(lineStart);
    return parsedUsage;
  }

  function consumePendingLine(tracker) {
    if (!tracker.pendingBytes.length) return false;
    const text = tracker.pendingBytes.toString("utf-8");
    const parsed = tracker.parser.pushLine(text);
    onMainLine(tracker, text);
    tracker.pendingBytes = Buffer.alloc(0);
    return parsed;
  }

  function consumeSubagentBytes(tracker, reader, buffer) {
    const combined = Buffer.concat([reader.pendingBytes, buffer]);
    let lineStart = 0;
    for (let index = 0; index < combined.length; index += 1) {
      if (combined[index] !== 0x0a) continue;
      let line = combined.subarray(lineStart, index);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length) tracker.parser.pushLine(line.toString("utf-8"));
      lineStart = index + 1;
    }
    reader.pendingBytes = combined.subarray(lineStart);
  }

  async function ensureRemoteClient(tracker) {
    if (tracker.remoteClient) return tracker.remoteClient;
    if (!tracker.remoteClientPromise) {
      const request = sshSessionRuntime.connectClient(tracker.session.id, {
        actionName: "Agent live token statistics",
        timeoutMs: 10000
      }).then(client => {
        if (tracker.remoteClientPromise !== request) {
          try { client.end?.(); } catch { /* Ignore stale connection cleanup failures. */ }
          throw new Error("Remote token tracker was closed.");
        }
        tracker.remoteClient = client;
        client.on?.("close", () => {
          if (tracker.remoteClient === client) tracker.remoteClient = null;
        });
        return client;
      }).finally(() => {
        if (tracker.remoteClientPromise === request) tracker.remoteClientPromise = null;
      });
      tracker.remoteClientPromise = request;
    }
    return tracker.remoteClientPromise;
  }

  function getRemoteReaderState(tracker) {
    const state = { [tracker.hostPath]: { identity: tracker.fileIdentity, offset: tracker.offset } };
    for (const [filePath, reader] of tracker.subagentReaders) {
      state[filePath] = { identity: reader.fileIdentity, offset: reader.offset };
    }
    return state;
  }

  async function readRemoteAppendedBytes(tracker) {
    const client = await ensureRemoteClient(tracker);
    let output;
    try {
      output = await runSshClientCommand(client, remoteDeltaCommand(tracker.hostPath, getRemoteReaderState(tracker)));
    } catch (error) {
      if (tracker.remoteClient === client) closeRemoteClient(tracker);
      throw error;
    }
    const result = JSON.parse(output);
    const main = result?.main;
    if (!main || main.path !== tracker.hostPath || !Number.isInteger(main.offset) || !Number.isInteger(main.start)) {
      throw new Error("Remote transcript reader returned an invalid response.");
    }
    const mainReset = main.start === 0 && (tracker.offset > 0 || (tracker.fileIdentity && tracker.fileIdentity !== main.identity));
    if (mainReset) reset(tracker);
    tracker.fileIdentity = main.identity;
    tracker.offset = main.offset;
    let parsedUsage = consumeMainBytes(tracker, Buffer.from(String(main.data || ""), "base64"));

    for (const item of Array.isArray(result.subagents) ? result.subagents : []) {
      if (!item?.path || !Number.isInteger(item.offset) || !Number.isInteger(item.start)) continue;
      let reader = tracker.subagentReaders.get(item.path);
      if (!reader) {
        reader = { fileIdentity: null, offset: 0, pendingBytes: Buffer.alloc(0) };
        tracker.subagentReaders.set(item.path, reader);
      }
      if (mainReset && item.start > 0) continue;
      if (item.start === 0 && (reader.offset > 0 || (reader.fileIdentity && reader.fileIdentity !== item.identity))) {
        reader.offset = 0;
        reader.pendingBytes = Buffer.alloc(0);
      }
      reader.fileIdentity = item.identity;
      reader.offset = item.offset;
      const before = tracker.parser.getResult()?.tokens?.totalTokens;
      consumeSubagentBytes(tracker, reader, Buffer.from(String(item.data || ""), "base64"));
      parsedUsage = tracker.parser.getResult()?.tokens?.totalTokens !== before || parsedUsage;
    }
    return parsedUsage;
  }

  async function readLocalAppendedBytes(tracker) {
    const stat = await fsPromises.stat(tracker.hostPath);
    if (stat.size > MAX_TRANSCRIPT_BYTES) throw new Error("Agent transcript exceeds the live monitoring size limit.");
    const fileIdentity = `${stat.dev ?? ""}:${stat.ino ?? ""}:${stat.birthtimeMs ?? ""}`;
    if (tracker.fileIdentity !== null && tracker.fileIdentity !== fileIdentity) reset(tracker);
    tracker.fileIdentity = fileIdentity;
    if (stat.size < tracker.offset) reset(tracker);
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
    return consumeMainBytes(tracker, buffer.subarray(0, bytesRead));
  }

  async function readSubagentAppendedBytes(tracker) {
    if (tracker.provider !== "codebuddy" || tracker.remote) return;
    const subagentsDir = getCodeBuddySubagentsDir(tracker.hostPath);
    if (!subagentsDir) return;
    let entries;
    try { entries = await fsPromises.readdir(subagentsDir); } catch { return; }
    for (const entry of [...entries].sort()) {
      if (!entry.toLowerCase().endsWith(".jsonl")) continue;
      const filePath = path.join(subagentsDir, entry);
      try {
        const stat = await fsPromises.stat(filePath);
        if (stat.size > MAX_TRANSCRIPT_BYTES) continue;
        let reader = tracker.subagentReaders.get(filePath);
        if (!reader) {
          reader = { offset: 0, pendingBytes: Buffer.alloc(0) };
          tracker.subagentReaders.set(filePath, reader);
        }
        if (stat.size < reader.offset) {
          reader.offset = 0;
          reader.pendingBytes = Buffer.alloc(0);
        }
        if (stat.size === reader.offset) continue;
        const length = stat.size - reader.offset;
        const handle = await fsPromises.open(filePath, "r");
        const buffer = Buffer.alloc(length);
        let bytesRead = 0;
        try {
          while (bytesRead < length) {
            const result = await handle.read(buffer, bytesRead, length - bytesRead, reader.offset + bytesRead);
            if (!result.bytesRead) break;
            bytesRead += result.bytesRead;
          }
        } finally {
          await handle.close();
        }
        reader.offset += bytesRead;
        consumeSubagentBytes(tracker, reader, buffer.subarray(0, bytesRead));
      } catch { /* Skip temporarily unreadable subagent transcripts. */ }
    }
  }

  async function readAppendedBytes(tracker) {
    if (tracker.remote) return readRemoteAppendedBytes(tracker);
    const parsed = await readLocalAppendedBytes(tracker);
    await readSubagentAppendedBytes(tracker);
    return parsed;
  }

  return {
    closeRemoteClient,
    consumePendingLine,
    createParser,
    readAppendedBytes,
    reset,
    resolveTrackerSource
  };
}

module.exports = {
  MAX_TRANSCRIPT_BYTES,
  REMOTE_DELTA_SCRIPT,
  createTranscriptSource,
  remoteDeltaCommand,
  runSshClientCommand,
  shellQuote
};
