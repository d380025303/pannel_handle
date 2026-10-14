import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createAgentTokenStatsService: createAgentTokenStatsServiceImpl, REMOTE_DELTA_SCRIPT } = require("./agent-token-stats-service.cjs");
const { createSshAgentTransport } = require("../../ssh/ssh-agent-transport.cjs");
const { createAgentTokenStatsStore } = require("./agent-token-stats-store.cjs");

function createAgentTokenStatsService(options) {
  const { sshSessionRuntime, ...serviceOptions } = options;
  if (!serviceOptions.sshAgentTransport && sshSessionRuntime) {
    serviceOptions.sshAgentTransport = createSshAgentTransport({ sshSessionRuntime });
  }
  return createAgentTokenStatsServiceImpl(serviceOptions);
}

function codexLine(inputTokens, outputTokens) {
  return `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } } } })}\n`;
}

function qoderLine(id, inputTokens, outputTokens) {
  return `${JSON.stringify({ type: "assistant", uuid: `row-${id}`, message: { id, model: "qoder-model", usage: { input_tokens: inputTokens, output_tokens: outputTokens }, content: [] } })}\n`;
}

function codeBuddyLine(id, inputTokens, outputTokens) {
  return `${JSON.stringify({ type: "message", providerData: { messageId: id, model: "hy3", usage: { inputTokens, outputTokens } } })}\n`;
}

function grokTurnLine(promptId, inputTokens, cachedReadTokens, outputTokens) {
  return `${JSON.stringify({
    timestamp: 1,
    params: {
      _meta: { promptId },
      update: {
        sessionUpdate: "turn_completed",
        usage: { inputTokens, cachedReadTokens, outputTokens, totalTokens: inputTokens + cachedReadTokens + outputTokens, modelUsage: { "grok-build": {} } }
      }
    }
  })}\n`;
}

function createMemoryFiles(initial = "", { beforeStat } = {}) {
  let content = Buffer.from(initial);
  return {
    append(value) { content = Buffer.concat([content, Buffer.from(value)]); },
    truncate(value = "") { content = Buffer.from(value); },
    promises: {
      stat: vi.fn(async () => {
        await beforeStat?.();
        return { size: content.length };
      }),
      open: vi.fn(async () => ({
        read: async (target, offset, length, position) => {
          const source = content.subarray(position, position + length);
          source.copy(target, offset);
          return { bytesRead: source.length };
        },
        close: async () => undefined
      }))
    }
  };
}

function remoteDelta(pathname, mainText = "", { mainOffset = 0, subagents = [] } = {}) {
  const mainBytes = Buffer.from(mainText);
  return JSON.stringify({
    main: {
      path: pathname,
      identity: "1:1",
      start: mainOffset,
      offset: mainOffset + mainBytes.length,
      data: mainBytes.toString("base64")
    },
    subagents: subagents.map(({ path: subagentPath, text, offset = 0 }, index) => {
      const bytes = Buffer.from(text);
      return {
        path: subagentPath,
        identity: `1:${index + 2}`,
        start: offset,
        offset: offset + bytes.length,
        data: bytes.toString("base64")
      };
    })
  });
}

function createSshClient(responses) {
  const client = new EventEmitter();
  const queue = [...responses];
  client.end = vi.fn();
  client.exec = vi.fn((_command, callback) => {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.close = vi.fn();
    callback(null, stream);
    queueMicrotask(() => {
      const response = queue.length > 1 ? queue.shift() : queue[0];
      if (response?.stderr) stream.stderr.emit("data", Buffer.from(response.stderr));
      if (response?.stdout) stream.emit("data", Buffer.from(response.stdout));
      stream.emit("close", response?.code ?? 0);
    });
  });
  return client;
}

function createHarness({ initial = "", now = 1_000, conversationSink = null, beforeStat } = {}) {
  const files = createMemoryFiles(initial, { beforeStat });
  const broadcasts = [];
  const intervals = [];
  let clock = now;
  const statsStore = {
    setBaseline: vi.fn(), update: vi.fn(), markEnded: vi.fn()
  };
  const service = createAgentTokenStatsService({
    terminalManager: {}, statsStore, sshSessionRuntime: {}, fsPromises: files.promises,
    now: () => clock,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    setIntervalFn: (callback) => { intervals.push(callback); return callback; },
    clearIntervalFn: vi.fn(),
    pollIntervalMs: 1000,
    conversationSink
  });
  const session = { id: "panel-1", type: "windows", title: "Codex", cwd: "C:\\work", agentProvider: "codex" };
  const input = { session_id: "agent-1", transcript_path: "C:\\tokens.jsonl", cwd: "C:\\work" };
  return { service, session, input, files, broadcasts, intervals, statsStore, setNow: value => { clock = value; } };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

describe("agent token live statistics", () => {
  it("persists matching local and remote CodeBuddy skills and tokens after Stop", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pannel-buddy-stop-"));
    const statsStore = createAgentTokenStatsStore({ databaseFile: ":memory:", Database: DatabaseSync });
    statsStore.load();
    const skill = id => JSON.stringify({ type: "tool_use", id, name: "Skill", input: { skill: "code-review" } });
    const main = [codeBuddyLine("main", 10, 5).trim(), skill("main-skill"), skill("main-repeat")];
    const subagent = [codeBuddyLine("sub", 3, 2).trim(), skill("sub-skill")];
    const sshAgentTransport = { exec: vi.fn(async () => JSON.stringify({ files: [main, subagent] })) };
    const service = createAgentTokenStatsService({
      terminalManager: {}, statsStore, sshAgentTransport, retryDelaysMs: [0],
      setIntervalFn: vi.fn(), clearIntervalFn: vi.fn()
    });
    try {
      const transcriptPath = path.join(directory, "session.jsonl");
      await mkdir(path.join(directory, "session", "subagents"), { recursive: true });
      await writeFile(transcriptPath, main.join("\n"));
      await writeFile(path.join(directory, "session", "subagents", "agent-one.jsonl"), subagent.join("\n"));
      for (const type of ["windows", "ssh"]) {
        service.handleHook({
          provider: "codebuddy",
          session: { id: `panel-${type}`, type, agentLocation: "remote", cwd: directory },
          input: { session_id: `buddy-${type}`, transcript_path: transcriptPath, hook_event_name: "Stop" }
        });
      }
      await vi.waitFor(() => expect(statsStore.getDashboard({ range: "all" }).sessions).toHaveLength(2));
      const records = statsStore.getDashboard({ range: "all" }).sessions;
      for (const record of records) {
        expect(record.capabilities.skills).toMatchObject({ totalCalls: 2, items: [{ name: "code-review", count: 2 }] });
        expect(record.tokens).toMatchObject({ inputTokens: 13, outputTokens: 7, totalTokens: 20 });
      }
      expect(records[0].tokens).toEqual(records[1].tokens);
      expect(sshAgentTransport.exec).toHaveBeenCalled();
    } finally {
      service.shutdown();
      statsStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])("keeps delayed SSH final usage ended when the panel is reused: %s", async reusePanel => {
    let database;
    const statsStore = createAgentTokenStatsStore({
      databaseFile: ":memory:", now: () => 1_000,
      Database: class extends DatabaseSync {
        constructor(file) { super(file); database = this; }
      }
    });
    statsStore.load();
    const readRecord = id => database.prepare("SELECT status, ended_at, total_tokens FROM token_sessions WHERE agent_session_id = ?").get(id);
    let resolveRead;
    const sshAgentTransport = { exec: vi.fn(() => new Promise(resolve => { resolveRead = resolve; })) };
    const broadcast = vi.fn();
    const service = createAgentTokenStatsService({
      terminalManager: {}, statsStore, sshAgentTransport, broadcast, retryDelaysMs: [0],
      setIntervalFn: vi.fn(), clearIntervalFn: vi.fn()
    });
    const session = { id: "panel-delayed", type: "ssh", agentLocation: "remote", title: "Remote", cwd: "/srv/app" };
    const initial = { provider: "codex", agentSessionId: "old-agent", panelSessionId: session.id, tokens: { totalTokens: 10, inputTokens: 10 } };
    try {
      statsStore.update(initial);
      service.handleHook({ provider: "codex", session, input: {
        hook_event_name: "SessionEnd", session_id: "old-agent", transcript_path: "/srv/old.jsonl"
      } });
      await vi.waitFor(() => expect(sshAgentTransport.exec).toHaveBeenCalledTimes(1));
      service.markEnded(session.id);
      expect(readRecord("old-agent").status).toBe("ended");
      if (reusePanel) {
        service.handleHook({ provider: "codex", session, input: { hook_event_name: "SessionStart", session_id: "new-agent" } });
        statsStore.update({ ...initial, agentSessionId: "new-agent", tokens: { totalTokens: 5, inputTokens: 5 } });
      }
      broadcast.mockClear();
      resolveRead(JSON.stringify([codexLine(20, 0).trim()]));
      await vi.waitFor(() => {
        const record = readRecord("old-agent");
        expect(record.total_tokens).toBe(20);
        expect(record.status).toBe("ended");
        expect(record.ended_at).toBeTruthy();
      });
      expect(broadcast).not.toHaveBeenCalled();
      if (reusePanel) expect(readRecord("new-agent").status).toBe("active");
      statsStore.clear();
      expect(database.prepare("SELECT COUNT(*) AS count FROM token_baselines WHERE agent_session_id = 'old-agent'").get().count).toBe(0);
      // An ended session must not acquire a reset baseline from clear().
      expect(statsStore.update({ ...initial, tokens: { totalTokens: 20, inputTokens: 20 } }).tokens.totalTokens).toBe(20);
      if (reusePanel) expect(statsStore.update({ ...initial, agentSessionId: "new-agent", tokens: { totalTokens: 8, inputTokens: 8 } }).tokens.totalTokens).toBe(3);
    } finally {
      service.shutdown();
      statsStore.close();
    }
  });

  it("reads main and CodeBuddy subagent deltas with the remote Python helper", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pannel-remote-token-"));
    try {
      const transcriptPath = path.join(directory, "session.jsonl");
      const subagentsDirectory = path.join(directory, "session", "subagents");
      const mainLine = codeBuddyLine("python-main", 2, 1);
      const subagentLine = codeBuddyLine("python-sub", 3, 2);
      await mkdir(subagentsDirectory, { recursive: true });
      await writeFile(transcriptPath, mainLine);
      await writeFile(path.join(subagentsDirectory, "agent-1.jsonl"), subagentLine);

      const result = spawnSync(process.platform === "win32" ? "python" : "python3", [
        "-c", REMOTE_DELTA_SCRIPT, transcriptPath, "{}", String(64 * 1024 * 1024)
      ], { encoding: "utf-8" });
      expect(result.status, result.stderr).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(Buffer.from(payload.main.data, "base64").toString("utf-8")).toBe(mainLine);
      expect(payload.subagents).toHaveLength(1);
      expect(Buffer.from(payload.subagents[0].data, "base64").toString("utf-8")).toBe(subagentLine);
      const codexResult = spawnSync(process.platform === "win32" ? "python" : "python3", [
        "-c", REMOTE_DELTA_SCRIPT, transcriptPath, "{}", String(64 * 1024 * 1024), "codex"
      ], { encoding: "utf-8" });
      expect(codexResult.status, codexResult.stderr).toBe(0);
      expect(JSON.parse(codexResult.stdout).subagents).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores hooks from removed providers", async () => {
    const harness = createHarness();
    harness.service.handleHook({
      provider: "qwen",
      input: { ...harness.input, hook_event_name: "SessionStart" },
      session: { ...harness.session, agentProvider: "qwen" }
    });
    await flush();

    expect(harness.statsStore.setBaseline).not.toHaveBeenCalled();
    expect(harness.statsStore.update).not.toHaveBeenCalled();
    expect(harness.service.getLive("panel-1")).toBeNull();
  });

  it("emits only current-turn Codex conversation messages through the live reader", async () => {
    const oldMessage = `${JSON.stringify({ type: "response_item", payload: { type: "message", id: "old", role: "assistant", phase: "final", content: [{ type: "output_text", text: "old" }] } })}\n`;
    const sink = { startTurn: vi.fn(), appendMessages: vi.fn(), completeTurn: vi.fn(), clearSession: vi.fn() };
    const harness = createHarness({ initial: oldMessage + codexLine(100, 20), conversationSink: sink });
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "SessionStart" }, session: harness.session });
    await flush();
    expect(sink.clearSession).not.toHaveBeenCalled();
    expect(sink.appendMessages).not.toHaveBeenCalled();

    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "UserPromptSubmit" }, session: harness.session });
    await vi.waitFor(() => expect(harness.service.getLive("panel-1")?.state).toBe("generating"));
    expect(sink.startTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "panel-1", supported: true }));
    harness.files.append(`${JSON.stringify({ type: "response_item", payload: { type: "message", id: "current", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "current" }] } })}\n`);
    await harness.intervals[0]();
    await vi.waitFor(() => expect(sink.appendMessages).toHaveBeenCalledWith("panel-1", [expect.objectContaining({ id: "current", text: "current" })]));

    harness.files.append(`${JSON.stringify({ type: "compacted", timestamp: "2026-01-01T00:00:00Z", payload: { message: "Conversation summary" } })}\n`);
    await harness.intervals[0]();
    await vi.waitFor(() => expect(sink.appendMessages).toHaveBeenCalledWith("panel-1", [expect.objectContaining({ kind: "summary", text: "Conversation summary" })]));

    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "Stop" }, session: harness.session });
    await flush();
    expect(sink.completeTurn).toHaveBeenCalledWith("panel-1");
  });

  it("passes the Codex Stop reply to conversation completion as a final fallback", async () => {
    const sink = { startTurn: vi.fn(), appendMessages: vi.fn(), completeTurn: vi.fn() };
    const harness = createHarness({ initial: codexLine(100, 20), conversationSink: sink });
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "SessionStart" }, session: harness.session });
    await flush();
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "UserPromptSubmit", turn_id: "turn-1" }, session: harness.session });
    await vi.waitFor(() => expect(harness.service.getLive("panel-1")?.state).toBe("generating"));

    harness.service.handleHook({
      provider: "codex",
      input: { ...harness.input, hook_event_name: "Stop", turn_id: "turn-1", last_assistant_message: "final fallback" },
      session: harness.session
    });

    await vi.waitFor(() => expect(sink.completeTurn).toHaveBeenCalledWith("panel-1", expect.objectContaining({
      id: "stop:turn-1",
      provider: "codex",
      text: "final fallback"
    })));
  });

  it("emits current Codex final_answer transcript records as final replies", async () => {
    const sink = { startTurn: vi.fn(), appendMessages: vi.fn(), completeTurn: vi.fn() };
    const harness = createHarness({ initial: codexLine(100, 20), conversationSink: sink });
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "SessionStart" }, session: harness.session });
    await flush();
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "UserPromptSubmit" }, session: harness.session });
    await vi.waitFor(() => expect(harness.service.getLive("panel-1")?.state).toBe("generating"));
    harness.files.append(`${JSON.stringify({ type: "response_item", payload: { type: "message", id: "current-final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "current answer" }] } })}\n`);

    await harness.intervals[0]();

    await vi.waitFor(() => expect(sink.appendMessages).toHaveBeenCalledWith("panel-1", [
      expect.objectContaining({ id: "current-final", kind: "final", text: "current answer" })
    ]));
  });

  it.each(["codex", "codebuddy"])("preserves %s conversations until the panel session ends", async (provider) => {
    const sink = { clearSession: vi.fn() };
    const harness = createHarness({ initial: codexLine(100, 20), conversationSink: sink });
    const session = { ...harness.session, agentProvider: provider };

    harness.service.handleHook({
      provider,
      input: { ...harness.input, hook_event_name: "SessionStart" },
      session
    });
    await flush();

    expect(sink.clearSession).not.toHaveBeenCalled();

    harness.service.markEnded(session.id);

    expect(harness.statsStore.markEnded).toHaveBeenCalledWith("panel-1");
    expect(sink.clearSession).toHaveBeenCalledTimes(1);
    expect(sink.clearSession).toHaveBeenCalledWith("panel-1");
    expect(harness.service.getLive("panel-1")).toBeNull();
  });

  it("supports remote SSH CodeBuddy conversations", () => {
    const sink = { startTurn: vi.fn() };
    const harness = createHarness({ conversationSink: sink });
    harness.service.handleHook({
      provider: "codebuddy",
      input: { ...harness.input, hook_event_name: "UserPromptSubmit" },
      session: { ...harness.session, type: "ssh", agentLocation: "remote", agentProvider: "codebuddy" }
    });
    expect(sink.startTurn).toHaveBeenCalledWith(expect.objectContaining({ provider: "codebuddy", supported: true }));
    expect(harness.service.getLive("panel-1")).not.toBeNull();
    harness.service.markEnded("panel-1");
  });

  it("streams remote CodeBuddy token deltas over one reusable SSH connection", async () => {
    const transcriptPath = "/home/test/.codebuddy/session.jsonl";
    const mainLine = codeBuddyLine("main-1", 10, 5);
    const subagentLine = codeBuddyLine("sub-1", 3, 2);
    const liveClient = createSshClient([
      { stdout: remoteDelta(transcriptPath) },
      { stdout: remoteDelta(transcriptPath) },
      {
        stdout: remoteDelta(transcriptPath, mainLine, {
          subagents: [{ path: "/home/test/.codebuddy/session/subagents/agent-1.jsonl", text: subagentLine }]
        })
      },
      {
        stdout: remoteDelta(transcriptPath, "", {
          mainOffset: Buffer.byteLength(mainLine),
          subagents: [{
            path: "/home/test/.codebuddy/session/subagents/agent-1.jsonl",
            text: "",
            offset: Buffer.byteLength(subagentLine)
          }]
        })
      }
    ]);
    const completedClient = createSshClient([{ stdout: JSON.stringify({ files: [[mainLine.trim()], [subagentLine.trim()]] }) }]);
    const baselineClient = createSshClient([{ stdout: JSON.stringify([]) }]);
    const connectClient = vi.fn(async (_sessionId, options) => {
      if (options.actionName === "Agent live token statistics") return liveClient;
      if (options.actionName === "Agent token statistics") {
        return connectClient.mock.calls.filter(([, value]) => value.actionName === "Agent token statistics").length === 1
          ? baselineClient
          : completedClient;
      }
      throw new Error(`Unexpected SSH action: ${options.actionName}`);
    });
    const intervals = [];
    const broadcasts = [];
    const sink = { startTurn: vi.fn(), completeTurn: vi.fn() };
    const statsStore = { setBaseline: vi.fn(), update: vi.fn(input => input), markEnded: vi.fn() };
    const service = createAgentTokenStatsService({
      terminalManager: {}, statsStore, sshSessionRuntime: { connectClient }, conversationSink: sink,
      retryDelaysMs: [0],
      setIntervalFn: callback => { intervals.push(callback); return callback; },
      clearIntervalFn: vi.fn(),
      broadcast: (channel, payload) => broadcasts.push({ channel, payload })
    });
    const session = { id: "panel-remote", type: "ssh", agentLocation: "remote", agentProvider: "codebuddy", title: "Remote", cwd: "/srv/app" };
    const input = { session_id: "buddy-remote", transcript_path: transcriptPath, cwd: "/srv/app" };

    service.handleHook({ provider: "codebuddy", input: { ...input, hook_event_name: "SessionStart" }, session });
    await vi.waitFor(() => expect(liveClient.exec).toHaveBeenCalledTimes(1));
    service.handleHook({ provider: "codebuddy", input: { ...input, hook_event_name: "UserPromptSubmit", prompt: "inspect" }, session });
    await vi.waitFor(() => expect(service.getLive(session.id)?.state).toBe("generating"));
    await vi.waitFor(() => expect(liveClient.exec).toHaveBeenCalledTimes(2));
    await intervals[0]();
    await vi.waitFor(() => expect(service.getLive(session.id)?.tokens).toMatchObject({ inputTokens: 13, outputTokens: 7, totalTokens: 20 }));

    expect(sink.startTurn).toHaveBeenCalledWith(expect.objectContaining({ supported: true }));
    expect(connectClient.mock.calls.filter(([, options]) => options.actionName === "Agent live token statistics")).toHaveLength(1);
    expect(broadcasts.some(event => event.payload?.tokens?.totalTokens === 20)).toBe(true);

    service.handleHook({ provider: "codebuddy", input: { ...input, hook_event_name: "Stop" }, session });
    await vi.waitFor(() => expect(service.getLive(session.id)?.state).toBe("completed"));
    await vi.waitFor(() => expect(statsStore.update).toHaveBeenCalled());
    expect(liveClient.end).toHaveBeenCalledTimes(1);
    expect(statsStore.update).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codebuddy",
      location: "ssh",
      tokens: expect.objectContaining({ totalTokens: 20 })
    }));
    service.shutdown();
  });

  it("reconnects remote CodeBuddy live tracking after an SSH read failure", async () => {
    const transcriptPath = "/home/test/.codebuddy/reconnect.jsonl";
    const failedClient = createSshClient([{ code: 1, stderr: "connection reset" }]);
    const line = codeBuddyLine("recovered-1", 4, 3);
    const recoveredClient = createSshClient([
      { stdout: remoteDelta(transcriptPath) },
      { stdout: remoteDelta(transcriptPath, line) }
    ]);
    const baselineClient = createSshClient([{ stdout: JSON.stringify([]) }]);
    const liveClients = [failedClient, recoveredClient];
    const connectClient = vi.fn(async (_sessionId, options) => options.actionName === "Agent live token statistics"
      ? liveClients.shift()
      : baselineClient);
    const intervals = [];
    const service = createAgentTokenStatsService({
      terminalManager: {},
      statsStore: { setBaseline: vi.fn(), update: vi.fn(), markEnded: vi.fn() },
      sshSessionRuntime: { connectClient },
      retryDelaysMs: [0],
      setIntervalFn: callback => { intervals.push(callback); return callback; },
      clearIntervalFn: vi.fn()
    });
    const session = { id: "panel-reconnect", type: "ssh", agentLocation: "remote", agentProvider: "codebuddy", title: "Remote", cwd: "/srv/app" };
    const input = { session_id: "buddy-reconnect", transcript_path: transcriptPath };

    service.handleHook({ provider: "codebuddy", input: { ...input, hook_event_name: "SessionStart" }, session });
    await vi.waitFor(() => expect(service.getLive(session.id)?.state).toBe("unavailable"));
    expect(failedClient.end).toHaveBeenCalledTimes(1);

    service.handleHook({ provider: "codebuddy", input: { ...input, hook_event_name: "UserPromptSubmit" }, session });
    await vi.waitFor(() => expect(service.getLive(session.id)?.state).toBe("generating"));
    await intervals[0]();
    await vi.waitFor(() => expect(service.getLive(session.id)?.tokens.totalTokens).toBe(7));
    expect(connectClient.mock.calls.filter(([, options]) => options.actionName === "Agent live token statistics")).toHaveLength(2);

    service.markEnded(session.id);
    expect(recoveredClient.end).toHaveBeenCalledTimes(1);
  });

  it("publishes session deltas and freezes the final average output rate", async () => {
    const harness = createHarness({ initial: codexLine(100, 20), now: 1_000 });
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "SessionStart" }, session: harness.session });
    await flush();
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "UserPromptSubmit" }, session: harness.session });
    await flush();

    harness.files.append(codexLine(160, 50));
    harness.setNow(4_000);
    await harness.intervals[0]();
    await flush();

    const generating = harness.service.getLive("panel-1");
    expect(generating).toMatchObject({
      state: "generating",
      tokens: { inputTokens: 60, outputTokens: 30 },
      turnOutputTokens: 30,
      outputTokensPerSecond: 10
    });

    harness.setNow(5_000);
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "Stop" }, session: harness.session });
    await flush();
    expect(harness.service.getLive("panel-1")).toMatchObject({ state: "completed", outputTokensPerSecond: 7.5 });
  });

  it("tracks deduplicated OpenCode usage events and persists accurate session totals", () => {
    const harness = createHarness({ now: 1_000 });
    const session = { ...harness.session, type: "ssh", agentProvider: "opencode", title: "OpenCode" };
    const baseInput = { session_id: "open-1", cwd: "/srv/app" };

    harness.service.handleHook({
      provider: "opencode",
      input: { ...baseInput, event_name: "session.status", status: { type: "busy" } },
      session
    });
    harness.setNow(4_000);
    harness.service.handleHook({
      provider: "opencode",
      input: {
        ...baseInput,
        event_name: "message.updated",
        info: {
          id: "message-one",
          role: "assistant",
          modelID: "glm-5.2",
          tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 30, write: 5 } }
        }
      },
      session
    });
    harness.service.handleHook({
      provider: "opencode",
      input: {
        ...baseInput,
        event_name: "message.updated",
        info: {
          id: "message-one",
          role: "assistant",
          modelID: "glm-5.2",
          tokens: { input: 100, output: 30, reasoning: 10, cache: { read: 30, write: 5 } }
        }
      },
      session
    });
    harness.service.handleHook({
      provider: "opencode",
      input: {
        ...baseInput,
        event_name: "message.updated",
        info: {
          id: "message-two",
          role: "assistant",
          modelID: "glm-5.2-mini",
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }
        }
      },
      session
    });

    expect(harness.service.getLive("panel-1")).toMatchObject({
      provider: "opencode",
      state: "generating",
      tokens: {
        inputTokens: 145,
        cachedInputTokens: 30,
        cacheWriteInputTokens: 5,
        outputTokens: 35,
        reasoningOutputTokens: 10,
        totalTokens: 190
      },
      turnOutputTokens: 35,
      outputTokensPerSecond: 11.7,
      models: ["glm-5.2", "glm-5.2-mini"]
    });
    expect(harness.statsStore.update).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: "opencode",
      agentSessionId: "open-1",
      location: "ssh",
      tokens: expect.objectContaining({ totalTokens: 190 })
    }));

    const persistedCalls = harness.statsStore.update.mock.calls.length;
    harness.service.handleHook({
      provider: "opencode",
      input: {
        ...baseInput,
        event_name: "message.updated",
        info: {
          id: "message-one",
          role: "assistant",
          modelID: "glm-5.2",
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        }
      },
      session
    });
    expect(harness.service.getLive("panel-1")?.tokens.totalTokens).toBe(190);
    expect(harness.statsStore.update).toHaveBeenCalledTimes(persistedCalls);

    harness.setNow(5_000);
    harness.service.handleHook({ provider: "opencode", input: { ...baseInput, event_name: "session.idle" }, session });
    expect(harness.service.getLive("panel-1")).toMatchObject({ state: "completed", outputTokensPerSecond: 8.8 });
  });

  it("keeps CodeBuddy live tracking on the main transcript when subagents emit hooks", async () => {
    const harness = createHarness({ initial: codeBuddyLine("main-one", 100, 20) });
    const session = { ...harness.session, agentProvider: "codebuddy" };
    const input = {
      ...harness.input,
      session_id: "main-agent",
      transcript_path: "C:\\work\\main.jsonl"
    };
    harness.service.handleHook({ provider: "codebuddy", input: { ...input, hook_event_name: "SessionStart", source: "resume" }, session });
    await flush();
    harness.service.handleHook({ provider: "codebuddy", input: { ...input, hook_event_name: "UserPromptSubmit" }, session });
    await flush();

    harness.service.handleHook({
      provider: "codebuddy",
      input: {
        ...input,
        session_id: "subagent-one",
        transcript_path: "C:\\work\\main\\subagents\\agent-one.jsonl",
        hook_event_name: "Stop"
      },
      session
    });
    harness.files.append(codeBuddyLine("main-two", 60, 30));
    await harness.intervals[0]();
    await flush();

    expect(harness.service.getLive("panel-1")).toMatchObject({
      provider: "codebuddy",
      state: "generating",
      tokens: { inputTokens: 60, outputTokens: 30 }
    });
    expect(harness.statsStore.update).not.toHaveBeenCalled();
  });

  it.each(["startup", undefined])("keeps the first CodeBuddy usage outside the %s session baseline", async (source) => {
    let releaseStat;
    const statGate = new Promise(resolve => { releaseStat = resolve; });
    const harness = createHarness({ beforeStat: () => statGate });
    const session = { ...harness.session, agentProvider: "codebuddy" };
    const input = {
      ...harness.input,
      session_id: "codebuddy-new",
      transcript_path: "C:\\work\\codebuddy-new.jsonl"
    };

    harness.service.handleHook({
      provider: "codebuddy",
      input: { ...input, hook_event_name: "SessionStart", ...(source ? { source } : {}) },
      session
    });
    harness.files.append(codeBuddyLine("first-response", 80, 25));
    releaseStat();

    await vi.waitFor(() => expect(harness.service.getLive("panel-1")).toMatchObject({
      provider: "codebuddy",
      tokens: { inputTokens: 80, outputTokens: 25, totalTokens: 105 }
    }));
  });

  it("resets a reused CodeBuddy tracker after clear", async () => {
    const harness = createHarness({ initial: codeBuddyLine("before-clear", 100, 20) });
    const session = { ...harness.session, agentProvider: "codebuddy" };
    const input = {
      ...harness.input,
      session_id: "codebuddy-clear",
      transcript_path: "C:\\work\\codebuddy-clear.jsonl"
    };

    harness.service.handleHook({ provider: "codebuddy", input: { ...input, hook_event_name: "SessionStart", source: "resume" }, session });
    await flush();
    harness.service.handleHook({ provider: "codebuddy", input: { ...input, hook_event_name: "SessionStart", source: "clear" }, session });
    harness.files.truncate();
    harness.service.handleHook({ provider: "codebuddy", input: { ...input, hook_event_name: "UserPromptSubmit" }, session });
    await flush();
    harness.files.append(codeBuddyLine("after-clear", 35, 12));
    await harness.intervals[0]();

    await vi.waitFor(() => expect(harness.service.getLive("panel-1")).toMatchObject({
      provider: "codebuddy",
      state: "generating",
      tokens: { inputTokens: 35, outputTokens: 12, totalTokens: 47 }
    }));
  });

  it("tracks Grok usage from ACP updates with snake-case hook events", async () => {
    const harness = createHarness();
    const session = { ...harness.session, agentProvider: "grok" };
    const input = {
      sessionId: "grok-session",
      transcriptPath: "C:\\work\\updates.jsonl"
    };

    harness.service.handleHook({ provider: "grok", input: { ...input, hookEventName: "session_start" }, session });
    await flush();
    harness.service.handleHook({ provider: "grok", input: { ...input, hookEventName: "user_prompt_submit" }, session });
    await vi.waitFor(() => expect(harness.service.getLive("panel-1")?.state).toBe("generating"));
    harness.files.append(grokTurnLine("turn-one", 12, 8, 5));
    await harness.intervals[0]();

    await vi.waitFor(() => expect(harness.service.getLive("panel-1")).toMatchObject({
      provider: "grok",
      state: "generating",
      tokens: { inputTokens: 12, cachedInputTokens: 8, outputTokens: 5, totalTokens: 25 },
      models: ["grok-build"]
    }));
  });

  it("delivers Grok whitespace chunks once through the live reader", async () => {
    const sink = { startTurn: vi.fn(), appendMessages: vi.fn(), completeTurn: vi.fn() };
    const harness = createHarness({ conversationSink: sink });
    const session = { ...harness.session, agentProvider: "grok" };
    const input = { sessionId: "grok-session", transcriptPath: "C:\\work\\updates.jsonl" };
    harness.service.handleHook({ provider: "grok", input: { ...input, hookEventName: "session_start" }, session });
    await flush();
    harness.service.handleHook({ provider: "grok", input: { ...input, hookEventName: "user_prompt_submit" }, session });
    await vi.waitFor(() => expect(harness.service.getLive("panel-1")?.state).toBe("generating"));
    const chunks = ["Hello", " ", "world", "\n", "next"];
    for (const [index, text] of chunks.entries()) {
      const line = JSON.stringify({ timestamp: index + 1, params: {
        _meta: { promptId: "turn-one", eventId: `chunk-${index}` },
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }
      } }) + "\n";
      harness.files.append(line + line);
    }
    await harness.intervals[0]();
    await vi.waitFor(() => expect(sink.appendMessages).toHaveBeenCalledTimes(chunks.length));
    const messages = sink.appendMessages.mock.calls.flatMap(([id, messages]) => {
      expect(id).toBe("panel-1");
      return messages;
    });
    expect(messages.map(message => message.text)).toEqual(chunks);
    expect(messages.map(message => message.text).join("")).toBe("Hello world\nnext");
  });

  it("tracks and persists Qoder transcript usage", async () => {
    const tempDirectory = await mkdtemp(path.join(tmpdir(), "pannel-handle-qoder-token-"));
    const transcriptPath = path.join(tempDirectory, "qoder.jsonl");
    await writeFile(transcriptPath, qoderLine("one", 100, 20), "utf-8");
    const intervals = [];
    const statsStore = {
      setBaseline: vi.fn(),
      markEnded: vi.fn(),
      update: vi.fn(input => input)
    };
    const service = createAgentTokenStatsService({
      terminalManager: {}, statsStore, sshSessionRuntime: {}, retryDelaysMs: [0],
      setIntervalFn: callback => { intervals.push(callback); return callback; },
      clearIntervalFn: vi.fn()
    });
    const session = { id: "panel-qoder", type: "windows", title: "Qoder", cwd: "C:\\work", agentProvider: "qoder" };
    const input = { session_id: "agent-qoder", transcript_path: transcriptPath, cwd: "C:\\work" };

    try {
      service.handleHook({ provider: "qoder", input: { ...input, hook_event_name: "SessionStart" }, session });
      await vi.waitFor(() => expect(statsStore.setBaseline).toHaveBeenCalledWith("qoder", "agent-qoder", expect.objectContaining({ totalTokens: 120 }), expect.anything()));
      service.handleHook({ provider: "qoder", input: { ...input, hook_event_name: "UserPromptSubmit" }, session });
      await vi.waitFor(() => expect(service.getLive("panel-qoder")?.state).toBe("generating"));
      await appendFile(transcriptPath, qoderLine("two", 20, 5), "utf-8");
      intervals[0]();
      await vi.waitFor(() => expect(service.getLive("panel-qoder")).toMatchObject({ tokens: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } }));

      service.handleHook({ provider: "qoder", input: { ...input, hook_event_name: "Stop" }, session });
      await vi.waitFor(() => expect(statsStore.update).toHaveBeenCalledWith(expect.objectContaining({
        provider: "qoder",
        agentSessionId: "agent-qoder",
        tokens: expect.objectContaining({ totalTokens: 145 })
      })));
      expect(service.getLive("panel-qoder")?.state).toBe("completed");
    } finally {
      service.shutdown();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("restarts parsing when a transcript is truncated", async () => {
    const harness = createHarness({ initial: codexLine(100, 20) });
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "SessionStart" }, session: harness.session });
    await flush();
    harness.files.truncate(codexLine(5, 2));
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "UserPromptSubmit" }, session: harness.session });
    await flush();
    expect(harness.service.getLive("panel-1")?.tokens).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it("holds a partial JSONL record until its newline arrives", async () => {
    const harness = createHarness({ initial: codexLine(100, 20).trimEnd() });
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "SessionStart" }, session: harness.session });
    await flush();
    expect(harness.service.getLive("panel-1")?.state).toBe("waiting");

    harness.files.append("\n");
    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "UserPromptSubmit" }, session: harness.session });
    await flush();
    expect(harness.service.getLive("panel-1")).toMatchObject({
      state: "generating",
      tokens: { inputTokens: 0, outputTokens: 0 }
    });
  });

  it("converts WSL transcript paths through the host bridge", async () => {
    const harness = createHarness();
    const convert = vi.fn(() => "\\\\wsl.localhost\\Ubuntu\\home\\me\\tokens.jsonl");
    const service = createAgentTokenStatsService({
      terminalManager: {}, statsStore: harness.statsStore, sshSessionRuntime: {}, fsPromises: harness.files.promises,
      toWslHostPathFn: convert, broadcast: () => undefined
    });
    service.handleHook({
      provider: "codex",
      input: { ...harness.input, hook_event_name: "SessionStart", transcript_path: "/home/me/tokens.jsonl" },
      session: { ...harness.session, type: "wsl", wslDistro: "Ubuntu" }
    });
    await flush();
    expect(convert).toHaveBeenCalledWith("Ubuntu", "/home/me/tokens.jsonl");
    service.shutdown();
  });

  it("tracks a local-bridge SSH Codex transcript from the Windows host", async () => {
    const tempDirectory = await mkdtemp(path.join(tmpdir(), "pannel-handle-token-"));
    const transcriptPath = path.join(tempDirectory, "bridge.jsonl");
    await writeFile(transcriptPath, codexLine(100, 20), "utf-8");
    const intervals = [];
    const broadcasts = [];
    const statsStore = {
      setBaseline: vi.fn(),
      markEnded: vi.fn(),
      update: vi.fn(input => ({ ...input, tokens: input.tokens, capabilities: input.capabilities, models: input.models }))
    };
    const sshSessionRuntime = { connectClient: vi.fn() };
    let clock = 1_000;
    const service = createAgentTokenStatsService({
      terminalManager: {},
      statsStore,
      sshSessionRuntime,
      now: () => clock,
      retryDelaysMs: [0],
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      setIntervalFn: callback => { intervals.push(callback); return callback; },
      clearIntervalFn: vi.fn()
    });
    const session = {
      id: "panel-bridge",
      type: "ssh",
      agentLocation: "local",
      title: "Bridge",
      cwd: "/srv/app",
      agentProvider: "codex"
    };
    const input = {
      session_id: "agent-bridge",
      transcript_path: transcriptPath,
      cwd: "C:\\runtime\\panel-bridge"
    };

    try {
      service.handleHook({ provider: "codex", input: { ...input, hook_event_name: "SessionStart" }, session });
      await vi.waitFor(() => expect(broadcasts.some(event => event.channel === "agent-token-live:changed")).toBe(true));
      service.handleHook({ provider: "codex", input: { ...input, hook_event_name: "UserPromptSubmit" }, session });
      await vi.waitFor(() => expect(service.getLive("panel-bridge")?.state).toBe("generating"));
      await appendFile(transcriptPath, codexLine(160, 50), "utf-8");
      clock = 4_000;
      await intervals[0]();
      await vi.waitFor(() => expect(service.getLive("panel-bridge")?.tokens).toMatchObject({ inputTokens: 60, outputTokens: 30 }));
      service.handleHook({ provider: "codex", input: { ...input, hook_event_name: "Stop" }, session });
      await vi.waitFor(() => expect(service.getLive("panel-bridge")?.state).toBe("completed"));
      await vi.waitFor(() => expect(statsStore.update).toHaveBeenCalled());

      expect(service.getLive("panel-bridge")).toMatchObject({
        state: "completed",
        tokens: { inputTokens: 60, outputTokens: 30 }
      });
      expect(statsStore.update).toHaveBeenCalledWith(expect.objectContaining({
        panelSessionId: "panel-bridge",
        location: "ssh",
        tokens: expect.objectContaining({ totalTokens: 210 })
      }));
      expect(sshSessionRuntime.connectClient).not.toHaveBeenCalled();
    } finally {
      service.shutdown();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("publishes a completed SSH snapshot after remote transcript collection", async () => {
    const broadcasts = [];
    const statsStore = {
      setBaseline: vi.fn(),
      markEnded: vi.fn(),
      update: vi.fn(input => ({ ...input, tokens: input.tokens, capabilities: input.capabilities, models: input.models }))
    };
    const transcript = [
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 } } } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "mcp-a", name: "mcp__remote__inspect", arguments: "{}" } })
    ];
    const sshSessionRuntime = {
      connectClient: vi.fn(async (_sessionId, options) => ({
        exec: (_command, callback) => {
          const stream = new EventEmitter();
          stream.stderr = new EventEmitter();
          callback(null, stream);
          queueMicrotask(() => {
            stream.emit("data", Buffer.from(options.actionName === "Agent live token statistics"
              ? remoteDelta("/tmp/session.jsonl", transcript.join("\n") + "\n")
              : JSON.stringify(transcript)));
            stream.emit("close", 0);
          });
        },
        end: vi.fn()
      }))
    };
    const service = createAgentTokenStatsService({
      terminalManager: {}, statsStore, sshSessionRuntime, retryDelaysMs: [0],
      broadcast: (channel, payload) => broadcasts.push({ channel, payload })
    });
    service.handleHook({
      provider: "codex",
      input: { session_id: "agent-ssh", transcript_path: "/tmp/session.jsonl", hook_event_name: "Stop" },
      session: { id: "panel-ssh", type: "ssh", title: "Remote", cwd: "/tmp" }
    });
    await flush();
    await flush();

    await vi.waitFor(() => expect(service.getLive("panel-ssh")).toMatchObject({
      state: "completed",
      tokens: { totalTokens: 35 },
      capabilities: { mcp: { totalCalls: 1 } }
    }));
    expect(broadcasts.some(event => event.channel === "agent-token-live:changed")).toBe(true);
  });
});
