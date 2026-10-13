import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { performance } from "node:perf_hooks";
import transcriptModule from "./agent-conversation-transcript.cjs";
import historyModule from "./agent-conversation-history-service.cjs";

function fixture(text, count = 1) {
  const root = path.join("fixture", ".codebuddy", "projects");
  const directory = name => ({ name, isDirectory: () => true, isFile: () => false });
  const file = name => ({ name, isDirectory: () => false, isFile: () => true });
  const promises = {
    readdir: vi.fn(async candidate => candidate === root
      ? [directory("other-project")]
      : Array.from({ length: count }, (_, index) => file(`buddy-${index}.jsonl`))),
    stat: vi.fn(async () => ({ size: Buffer.byteLength(text), mtimeMs: 1 })),
    readFile: vi.fn(async () => text)
  };
  const service = historyModule.createAgentConversationHistoryService({ homeDir: "fixture", fsApi: { promises },
    terminalManager: { getSession: () => ({ id: "run", type: "windows", cwd: "C:\\current" }) } });
  return { service, promises, filePath: path.join(root, "other-project", "buddy-0.jsonl") };
}

describe("asynchronous CodeBuddy history", () => {
  it("preserves metadata, malformed-line handling and cache invalidation", async () => {
    const text = [
      JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text: "Question" }], cwd: "C:\\other", timestamp: 20 }),
      "{partial", " ",
      JSON.stringify({ type: "ai-title", aiTitle: " First ", timestamp: 10 }),
      JSON.stringify({ type: "ai-title", aiTitle: " Last ", timestamp: 30 })
    ].join("\r\n");
    const f = fixture(text);
    const request = { panelSessionId: "run", providers: ["codebuddy"], scope: "all", limit: 1 };
    const first = await f.service.listHistory(request);
    expect(first).toEqual({ errors: [], nextCursor: null, items: [{ ref: "codebuddy:buddy-0", provider: "codebuddy",
      title: "Last", preview: "Question", cwd: "C:\\other", createdAt: 10000, updatedAt: 30000, archived: false }] });
    expect(await f.service.listHistory(request)).toEqual(first);
    expect(f.promises.readFile).toHaveBeenCalledTimes(1);
    f.promises.stat.mockResolvedValue({ size: text.length, mtimeMs: 2 });
    f.promises.readFile.mockResolvedValue(text + '\n{"type":"ai-title","aiTitle":"Changed"}');
    expect((await f.service.listHistory(request)).items[0].title).toBe("Changed");
    expect(f.promises.readFile).toHaveBeenCalledTimes(2);
  });

  it("returns empty history for a missing root and reports asynchronous read failures", async () => {
    const f = fixture("");
    f.promises.readdir.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const request = { panelSessionId: "run", providers: ["codebuddy"] };
    expect(await f.service.listHistory(request)).toEqual({ items: [], errors: [], nextCursor: null });
    f.promises.readFile.mockRejectedValueOnce(new Error("read failure"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await f.service.listHistory(request)).errors).toEqual([{ provider: "codebuddy", message: "CodeBuddy history is unavailable." }]);
    } finally { log.mockRestore(); }
  });

  it("pages 50,000 messages cooperatively and reuses unchanged first-page parses", async () => {
    const lines = Array.from({ length: 50_000 }, (_, index) => JSON.stringify({
      type: "message", role: index % 2 ? "assistant" : "user", id: `m-${index}`,
      timestamp: (index * 7919) % 50_000,
      content: [{ type: "text", text: "x".repeat(980) }]
    }));
    const text = [...lines, lines[10], "{partial", " ", JSON.stringify({
      type: "summary", id: "summary", summary: "Compacted", timestamp: 50001
    })].join("\r\n");
    const expected = transcriptModule.parseAgentConversationText("codebuddy", text, { includeUser: true })
      .sort((left, right) => right.timestamp - left.timestamp);
    const f = fixture(text);
    const request = { panelSessionId: "run", conversationRef: "codebuddy:buddy-0", limit: 50 };
    let completed = false;
    let timerBeforeCompletion = false;
    const started = performance.now();
    const timer = new Promise(resolve => setTimeout(() => {
      timerBeforeCompletion = !completed;
      resolve(performance.now() - started);
    }, 0));
    const first = await f.service.getHistoryMessages(request);
    completed = true;
    const timerMs = await timer;
    expect(timerBeforeCompletion).toBe(true);
    expect(first.messages).toEqual(expected.slice(0, 50));
    expect(first.nextCursor).toBe("50");
    expect((await f.service.getHistoryMessages({ ...request, cursor: first.nextCursor })).messages)
      .toEqual(expected.slice(50, 100));
    expect(await f.service.getHistoryMessages(request)).toEqual(first);
    expect(await f.service.getHistoryMessages(request)).toEqual(first);
    expect(f.promises.readFile).toHaveBeenCalledTimes(1);
    f.promises.stat.mockResolvedValue({ size: Buffer.byteLength(text), mtimeMs: 2 });
    f.promises.readFile.mockResolvedValue(lines[0]);
    expect((await f.service.getHistoryMessages(request)).messages).toEqual([expected.find(item => item.id === "m-0")]);
    expect(f.promises.readFile).toHaveBeenCalledTimes(2);
    console.info(JSON.stringify({ MiB: Buffer.byteLength(text) / 1024 ** 2, timerMs }));
  }, 15000);

  it("does not cache changing transcripts and evicts cached messages after read failures", async () => {
    const text = JSON.stringify({ type: "message", role: "user", id: "one", timestamp: 1,
      content: [{ type: "text", text: "Question" }] });
    const f = fixture(text);
    const request = { panelSessionId: "run", conversationRef: "codebuddy:buddy-0" };
    f.promises.stat.mockResolvedValueOnce({ size: text.length, mtimeMs: 0 });
    await f.service.getHistoryMessages(request);
    await f.service.getHistoryMessages(request);
    expect(f.promises.readFile).toHaveBeenCalledTimes(2);
    f.promises.stat.mockRejectedValueOnce(new Error("stat failure"));
    await expect(f.service.getHistoryMessages(request)).rejects.toThrow("stat failure");
    await f.service.getHistoryMessages(request);
    expect(f.promises.readFile).toHaveBeenCalledTimes(3);
    f.promises.stat.mockResolvedValue({ size: text.length, mtimeMs: 2 });
    f.promises.readFile.mockRejectedValueOnce(new Error("read failure"));
    await expect(f.service.getHistoryMessages(request)).rejects.toThrow("read failure");
    await f.service.getHistoryMessages(request);
    expect(f.promises.readFile).toHaveBeenCalledTimes(5);
  });

  it("keeps event-loop heartbeats running during a 200 MiB cold-cache cwd scan", async () => {
    const line = JSON.stringify({ type: "message", role: "assistant", cwd: "C:\\other", timestamp: 20, content: "x".repeat(5100) });
    const text = (line + "\n").repeat(1013);
    const f = fixture(text, 40);
    let beats = 0;
    let maxGap = 0;
    let previous = performance.now();
    const started = previous;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - previous);
      previous = now;
      beats++;
    }, 0);
    let result;
    try {
      result = await f.service.listHistory({ panelSessionId: "run", providers: ["codebuddy"], scope: "cwd", limit: 1 });
      maxGap = Math.max(maxGap, performance.now() - previous);
    } finally { clearInterval(timer); }
    expect(result).toEqual({ items: [], nextCursor: null, errors: [] });
    expect(f.promises.readFile).toHaveBeenCalledTimes(40);
    expect(beats).toBeGreaterThan(10);
    expect(maxGap).toBeLessThan(200);
    console.info(JSON.stringify({ MiB: Buffer.byteLength(text) * 40 / 1024 ** 2, elapsedMs: performance.now() - started, beats, maxGapMs: maxGap }));
  }, 15000);
});
