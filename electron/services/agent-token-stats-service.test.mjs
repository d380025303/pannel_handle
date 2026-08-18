import { createRequire } from "node:module";
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

function createHarness({ initial = "", now = 1_000 } = {}) {
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
    pollIntervalMs: 1000
  });
  const session = { id: "panel-1", type: "windows", title: "Codex", cwd: "C:\\work", agentProvider: "codex" };
  const input = { session_id: "agent-1", transcript_path: "C:\\tokens.jsonl", cwd: "C:\\work" };
  return { service, session, input, files, broadcasts, intervals, statsStore, setNow: value => { clock = value; } };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

describe("agent token live statistics", () => {
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
});
