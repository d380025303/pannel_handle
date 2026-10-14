import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createAgentTokenStatsService } = require("./agent-token-stats-service.cjs");
const { parseRemoteTranscriptAsync } = require("./agent-token-transcript-reader.cjs");
const { parseTranscriptText, mergeTranscriptResults } = require("./agent-token-transcript.cjs");

it.each(["ssh", "wsl"])("keeps timers running for large %s baseline and final hook reads", async type => {
  const lines = Array.from({ length: 100000 }, (_, index) => JSON.stringify({
    type: "event_msg", payload: { type: "token_count", info: { total_token_usage: {
      input_tokens: index + 100, output_tokens: index + 20,
      cached_input_tokens: 10, reasoning_output_tokens: 5, total_tokens: index * 2 + 120
    } } }
  }));
  lines.unshift(JSON.stringify({ type: "session_meta", payload: { model: "codex-test" } }));
  lines.push(JSON.stringify({ type: "response_item", payload: {
    type: "function_call", call_id: "tool-1", name: "mcp__test__query", arguments: "{}"
  } }));
  const response = JSON.stringify(lines);
  const expected = parseTranscriptText("codex", lines.join("\n"));
  expect(expected.models).toEqual(["codex-test"]);
  expect(expected.capabilities.mcp.totalCalls).toBe(1);
  const statsStore = { setBaseline: vi.fn(), update: vi.fn(), markEnded: vi.fn() };
  const service = createAgentTokenStatsService({
    terminalManager: {}, statsStore, retryDelaysMs: [0],
    sshAgentTransport: { exec: async () => response },
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(response));
        child.emit("close", 0);
      });
      return child;
    },
    setIntervalFn: () => null, clearIntervalFn: () => {},
    toWslHostPathFn: () => "C:\\missing-token-worker-transcript"
  });
  try {
    for (const event of ["SessionStart", "SessionEnd"]) {
      const callback = event === "SessionStart" ? statsStore.setBaseline : statsStore.update;
      let ticks = 0;
      const start = performance.now();
      const timer = setInterval(() => { if (!callback.mock.calls.length) ticks++; }, 1);
      let firstTimerMs;
      const firstTimer = new Promise(resolve => setTimeout(() => {
        firstTimerMs = performance.now() - start;
        resolve();
      }, 0));
      try {
        service.handleHook({ provider: "codex",
          session: { id: "panel-remote", type, wslDistro: "test", agentLocation: "remote" },
          input: { session_id: "agent-remote", transcript_path: "/tmp/session.jsonl", hook_event_name: event }
        });
        await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce(), { timeout: 10000, interval: 10 });
        await firstTimer;
        expect(ticks).toBeGreaterThan(2);
        if (event === "SessionStart") {
          expect(callback).toHaveBeenCalledWith("codex", "agent-remote", expected.tokens, expected.capabilities);
        } else {
          expect(callback.mock.calls[0][0]).toMatchObject(expected);
        }
        console.info(JSON.stringify({ type, event, sizeMiB: response.length / 1024 / 1024,
          firstTimerMs, ticks, elapsedMs: performance.now() - start }));
      } finally { clearInterval(timer); }
    }
  } finally { service.shutdown(); }
}, 20000);

it("preserves remote CodeBuddy subagent tokens, models and capabilities", async () => {
  const files = ["main", "child"].map((id, index) => [
    JSON.stringify({ providerData: { messageId: id, model: `${id}-model`,
      rawUsage: { prompt_tokens: 10 + index, completion_tokens: 5 } } }),
    JSON.stringify({ type: "function_call", id: `tool-${id}`, name: "mcp__test__query", input: {} })
  ]);
  expect(await parseRemoteTranscriptAsync("codebuddy", JSON.stringify({ files })))
    .toEqual(mergeTranscriptResults(files.map(lines => parseTranscriptText("codebuddy", lines.join("\n")))));
  await expect(parseRemoteTranscriptAsync("codex", "invalid-json")).rejects.toMatchObject({ name: "SyntaxError" });
  await expect(parseRemoteTranscriptAsync("codex", "[]")).rejects.toThrow("does not contain usage yet");
  await expect(parseRemoteTranscriptAsync("codebuddy", JSON.stringify({ files }))).resolves.toBeDefined();
});
