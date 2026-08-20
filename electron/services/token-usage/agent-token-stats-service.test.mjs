import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createAgentTokenStatsService } = require("./agent-token-stats-service.cjs");

function codexLine(inputTokens, outputTokens) {
  return `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } } } })}\n`;
}

function createMemoryFiles(initial = "") {
  let content = Buffer.from(initial);
  return {
    append(value) { content = Buffer.concat([content, Buffer.from(value)]); },
    truncate(value = "") { content = Buffer.from(value); },
    promises: {
      stat: vi.fn(async () => ({ size: content.length })),
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

function createHarness({ initial = "", now = 1_000, conversationSink = null } = {}) {
  const files = createMemoryFiles(initial);
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

    harness.service.handleHook({ provider: "codex", input: { ...harness.input, hook_event_name: "Stop" }, session: harness.session });
    await flush();
    expect(sink.completeTurn).toHaveBeenCalledWith("panel-1");
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

  it("marks pure remote SSH turns as unsupported without polling the transcript", () => {
    const sink = { startTurn: vi.fn() };
    const harness = createHarness({ conversationSink: sink });
    harness.service.handleHook({
      provider: "codebuddy",
      input: { ...harness.input, hook_event_name: "UserPromptSubmit" },
      session: { ...harness.session, type: "ssh", agentLocation: "remote", agentProvider: "codebuddy" }
    });
    expect(sink.startTurn).toHaveBeenCalledWith(expect.objectContaining({ provider: "codebuddy", supported: false }));
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
      connectClient: vi.fn(async () => ({
        exec: (_command, callback) => {
          const stream = new EventEmitter();
          stream.stderr = new EventEmitter();
          callback(null, stream);
          queueMicrotask(() => {
            stream.emit("data", Buffer.from(JSON.stringify(transcript)));
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

    expect(service.getLive("panel-ssh")).toMatchObject({
      state: "completed",
      tokens: { totalTokens: 35 },
      capabilities: { mcp: { totalCalls: 1 } }
    });
    expect(broadcasts.some(event => event.channel === "agent-token-live:changed")).toBe(true);
  });
});
