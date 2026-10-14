import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { parseTranscriptFileAsync } = require("./agent-token-transcript-reader.cjs");
const { parseTranscriptFileWithSubagents } = require("./agent-token-transcript.cjs");

async function measure(read) {
  const start = performance.now();
  let completed = false;
  const timer = new Promise(resolve => setTimeout(() => resolve({
    delay: performance.now() - start, beforeCompletion: !completed
  }), 0));
  const result = await read();
  completed = true;
  const elapsed = performance.now() - start;
  return { result, elapsed, timer: await timer };
}

describe("transcript worker reader", () => {
  it.each([10, 50])("preserves %i MiB Claude statistics while timers keep running", async size => {
    const directory = await mkdtemp(path.join(tmpdir(), "token-worker-"));
    try {
      const file = path.join(directory, "claude.jsonl");
      const line = JSON.stringify({ type: "assistant", message: {
        id: "deduplicated-message", model: "claude-test", usage: {
          input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10
        }, content: [{ type: "tool_use", id: "tool-1", name: "mcp__test__query", input: {} },
          { type: "text", text: "x".repeat(1800) }]
      } }) + "\n";
      const bytes = size * 1024 * 1024;
      const content = line.repeat(Math.floor(bytes / Buffer.byteLength(line)));
      // A valid JSONL transcript with exactly the requested byte size.
      await writeFile(file, content + " ".repeat(bytes - Buffer.byteLength(content)));
      for (let run = 1; run <= 3; run++) {
        const sync = await measure(() => parseTranscriptFileWithSubagents("claude", file));
        const worker = await measure(() => parseTranscriptFileAsync("claude", file));
        expect(worker.result).toEqual(sync.result);
        expect(worker.timer.beforeCompletion).toBe(true);
        expect(sync.timer.beforeCompletion).toBe(false);
        console.info(JSON.stringify({ sizeMiB: size, run,
          syncMs: Math.round(sync.elapsed), syncTimerMs: Math.round(sync.timer.delay),
          workerMs: Math.round(worker.elapsed), workerTimerMs: Math.round(worker.timer.delay) }));
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20000);

  it("preserves CodeBuddy subagent aggregation and tolerates pending subagents", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "token-worker-"));
    try {
      const file = path.join(directory, "session.jsonl");
      const subagents = path.join(directory, "session", "subagents");
      await mkdir(subagents, { recursive: true });
      const message = (id, input, model) => JSON.stringify({ providerData: {
        messageId: id, model, rawUsage: { prompt_tokens: input, completion_tokens: 5 }
      } });
      await writeFile(file, message("main", 10, "main-model"));
      await writeFile(path.join(subagents, "one.jsonl"), [message("one", 20, "child-model"),
        message("one", 30, "child-model"), JSON.stringify({ type: "function_call",
          id: "tool-1", name: "mcp__database__query", input: {} })].join("\n"));
      await writeFile(path.join(subagents, "two.jsonl"), message("two", 40, "child-model"));
      await writeFile(path.join(subagents, "pending.jsonl"), "incomplete-json\n");
      const result = await parseTranscriptFileAsync("codebuddy", file);
      expect(result).toEqual(parseTranscriptFileWithSubagents("codebuddy", file));
      expect(result.tokens.totalTokens).toBe(95);
      expect(result.capabilities.mcp.totalCalls).toBe(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects failed reads and can read again after the transcript becomes available", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "token-worker-"));
    try {
      const file = path.join(directory, "missing.jsonl");
      await expect(parseTranscriptFileAsync("claude", file)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(file, "{}\n");
      await expect(parseTranscriptFileAsync("claude", file)).rejects.toThrow("does not contain usage yet");
      await writeFile(file, JSON.stringify({ type: "assistant", message: {
        id: "ready", usage: { input_tokens: 10, output_tokens: 5 }
      } }));
      expect((await parseTranscriptFileAsync("claude", file)).tokens.totalTokens).toBe(15);
      await expect(parseTranscriptFileAsync("unsupported", file)).rejects.toThrow("Unsupported");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
