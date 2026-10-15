const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const {
  createIncrementalTranscriptParser,
  getCodeBuddySubagentsDir
} = require("../agent-token-transcript.cjs");
const { createCopilotOtelParser, getCopilotOtelPath } = require("../copilot-otel.cjs");

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const PARSE_BATCH_BYTES = 256 * 1024;
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
  "for p in (sorted(glob.glob(os.path.join(d,'*.jsonl'))) if len(sys.argv)<5 or sys.argv[4]=='codebuddy' else []):",
  " try: result['subagents'].append(read_delta(p))",
  " except Exception: pass",
  "print(json.dumps(result,separators=(',',':')))"
].join("\n");

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function remoteDeltaCommand(transcriptPath, readerState, provider = "codebuddy") {
  return `python3 -c ${shellQuote(REMOTE_DELTA_SCRIPT)} ${shellQuote(transcriptPath)} ${shellQuote(JSON.stringify(readerState))} ${MAX_TRANSCRIPT_BYTES} ${shellQuote(provider)}`;
}

function createTranscriptSource({
  sshAgentTransport,
  fsPromises = fs.promises,
  toWslHostPath,
  onMainLine = () => {},
  onReset = () => {}
}) {
  function isLocalSshBridge(session) {
    return session?.type === "ssh" && session.agentLocation === "local";
  }

  function isRemoteTranscript(session, provider) {
    return (provider === "codebuddy" || provider === "codex") && session?.type === "ssh" && !isLocalSshBridge(session);
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
    const remote = isRemoteTranscript(session, provider);
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
    tracker.cancelRemoteDecode?.();
    const client = tracker.remoteClient;
    tracker.remoteClient = null;
    try { client?.close?.(); } catch { /* Ignore SSH cleanup failures. */ }
  }

  function decodeRemoteDelta(tracker, output) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "remote-delta-worker.cjs"), {
        workerData: { output, provider: tracker.provider }
      });
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        if (tracker.cancelRemoteDecode === cancel) tracker.cancelRemoteDecode = null;
        void worker.terminate();
        if (error) reject(error);
        else resolve(result);
      };
      const cancel = () => finish(null, null);
      tracker.cancelRemoteDecode = cancel;
      worker.once("message", message => finish(message.error ? new Error(message.error) : null, message.result));
      worker.once("error", error => finish(error));
      worker.once("exit", code => finish(new Error(`Remote transcript decoder exited before returning a response (${code}).`)));
    });
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

  async function consumeLines(tracker, reader, buffer, onLine) {
    const combined = reader.pendingBytes.length
      ? Buffer.concat([reader.pendingBytes, buffer])
      : buffer;
    let lineStart = 0;
    let parsedUsage = false;
    for (let batchStart = 0; batchStart < combined.length; batchStart += PARSE_BATCH_BYTES) {
      if (batchStart > 0) {
        await new Promise(resolve => setImmediate(resolve));
        if (tracker.disposed) return false;
      }
      // Bound the search even within a long line; parse only complete JSON/UTF-8 lines.
      const batch = combined.subarray(batchStart, batchStart + PARSE_BATCH_BYTES);
      let newline = batch.indexOf(0x0a);
      while (newline !== -1) {
        const index = batchStart + newline;
        if (index > lineStart) {
          let line = combined.subarray(lineStart, index);
          if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
          if (line.length) {
            const text = line.toString("utf-8");
            parsedUsage = tracker.parser.pushLine(text) || parsedUsage;
            onLine?.(tracker, text);
          }
        }
        lineStart = index + 1;
        newline = batch.indexOf(0x0a, newline + 1);
      }
    }
    reader.pendingBytes = lineStart < combined.length
      ? Buffer.from(combined.subarray(lineStart))
      : Buffer.alloc(0);
    return parsedUsage;
  }

  function consumeMainBytes(tracker, buffer) {
    return consumeLines(tracker, tracker, buffer, onMainLine);
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
    return consumeLines(tracker, reader, buffer);
  }

  function ensureRemoteClient(tracker) {
    if (tracker.remoteClient) return tracker.remoteClient;
    tracker.remoteClient = sshAgentTransport.createReusableCommandClient(tracker.session.id, {
      actionName: "Agent live token statistics",
      timeoutMs: 10000,
      commandName: "Remote transcript reader",
      closedMessage: "Remote token tracker was closed.",
      maxOutputBytes: Math.ceil(MAX_TRANSCRIPT_BYTES * 4 / 3) + 1024 * 1024,
      outputLimitMessage: "Remote transcript delta exceeds the live monitoring size limit."
    });
    return tracker.remoteClient;
  }

  function getRemoteReaderState(tracker) {
    const state = { [tracker.hostPath]: { identity: tracker.fileIdentity, offset: tracker.offset } };
    for (const [filePath, reader] of tracker.subagentReaders) {
      state[filePath] = { identity: reader.fileIdentity, offset: reader.offset };
    }
    return state;
  }

  async function readRemoteAppendedBytes(tracker) {
    const client = ensureRemoteClient(tracker);
    let output;
    try {
      output = await client.exec(remoteDeltaCommand(tracker.hostPath, getRemoteReaderState(tracker), tracker.provider));
    } catch (error) {
      if (tracker.remoteClient === client) closeRemoteClient(tracker);
      throw error;
    }
    if (tracker.disposed) return false;
    const result = await decodeRemoteDelta(tracker, output);
    if (tracker.disposed) return false;
    const main = result?.main;
    if (!main || main.path !== tracker.hostPath || !Number.isInteger(main.offset) || !Number.isInteger(main.start)) {
      throw new Error("Remote transcript reader returned an invalid response.");
    }
    const mainReset = main.start === 0 && (tracker.offset > 0 || (tracker.fileIdentity && tracker.fileIdentity !== main.identity));
    if (mainReset) reset(tracker);
    tracker.fileIdentity = main.identity;
    tracker.offset = main.offset;
    let parsedUsage = await consumeMainBytes(tracker, Buffer.from(main.data.buffer, main.data.byteOffset, main.data.byteLength));

    if (tracker.disposed) return false;
    for (const item of tracker.provider === "codebuddy" && Array.isArray(result.subagents) ? result.subagents : []) {
      if (tracker.disposed) return false;
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
      await consumeSubagentBytes(tracker, reader, Buffer.from(item.data.buffer, item.data.byteOffset, item.data.byteLength));
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
      if (tracker.disposed) return;
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
        await consumeSubagentBytes(tracker, reader, buffer.subarray(0, bytesRead));
      } catch { /* Skip temporarily unreadable subagent transcripts. */ }
    }
  }

  async function readAppendedBytes(tracker) {
    if (tracker.remote) return readRemoteAppendedBytes(tracker);
    const parsed = await readLocalAppendedBytes(tracker);
    if (!tracker.disposed) await readSubagentAppendedBytes(tracker);
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
  shellQuote
};
