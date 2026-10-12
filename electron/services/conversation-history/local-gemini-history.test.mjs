import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { performance } from "node:perf_hooks";
import historyModule from "./agent-conversation-history-service.cjs";
import geminiModule from "./local-gemini-history.cjs";

function fixture(text, count = 1, extension = "json") {
  const cwd = "C:\\current";
  const hash = geminiModule.geminiProjectHash(cwd);
  const root = path.join(process.env.GEMINI_CLI_HOME || "fixture", ".gemini", "tmp");
  const promises = {
    readdir: vi.fn(async candidate => candidate === root
      ? [{ name: hash, isDirectory: () => true }]
      : Array.from({ length: count }, (_, index) => ({ name: `session-${index}.${extension}`, isFile: () => true }))),
    stat: vi.fn(async () => ({ size: Buffer.byteLength(text), mtimeMs: 123 })),
    readFile: vi.fn(async () => text)
  };
  const service = historyModule.createAgentConversationHistoryService({ homeDir: "fixture", fsApi: { promises },
    terminalManager: { getSession: () => ({ id: "run", type: "windows", cwd }) } });
  return { service, promises, hash, cwd };
}
const request = { panelSessionId: "run", providers: ["gemini"], limit: 20 };

describe("asynchronous Gemini history", () => {
  it("preserves JSON metadata and request scope while invalidating size and mtime changes", async () => {
    const text = JSON.stringify({ sessionId: "acp", startTime: 10, messages: [
      { id: "u", type: "user", content: " Question ", timestamp: 20 },
      { id: "a", type: "gemini", content: "Answer", timestamp: 30 }
    ] });
    const f = fixture(text);
    const first = await f.service.listHistory(request);
    expect(first).toEqual({ errors: [], nextCursor: null, items: [{ ref: `gemini:${f.hash}:session-0`, acpSessionId: "acp",
      provider: "gemini", title: "Question", preview: "Question", cwd: f.cwd, createdAt: 10000, updatedAt: 30000, archived: false }] });
    expect(await f.service.listHistory(request)).toEqual(first);
    expect((await f.service.listHistory({ ...request, scope: "all" })).items[0].cwd).toBe("");
    expect(await f.service.listHistory(request)).toEqual(first);
    expect(f.promises.readFile).toHaveBeenCalledTimes(1);
    for (const stat of [{ size: Buffer.byteLength(text), mtimeMs: 124 }, { size: Buffer.byteLength(text) + 1, mtimeMs: 124 }]) {
      f.promises.stat.mockResolvedValue(stat);
      await f.service.listHistory(request);
    }
    expect(f.promises.readFile).toHaveBeenCalledTimes(3);
  });

  it("preserves JSONL checkpoints, rewind, malformed lines and timestamp fallback", async () => {
    const text = [JSON.stringify({ sessionId: "acp" }), "{partial", JSON.stringify({ $set: { messages: [
      { id: "u", type: "user", content: "Question", timestamp: 20 },
      { id: "old", type: "gemini", content: "Old", timestamp: 30 }
    ] } }), JSON.stringify({ $rewindTo: "old" }), JSON.stringify({ id: "new", type: "gemini", content: "New" })].join("\n");
    const f = fixture(text, 1, "jsonl");
    expect((await f.service.listHistory(request)).items[0]).toMatchObject({ title: "Question", createdAt: 20000, updatedAt: 123 });
  });

  it("handles missing directories, read failures, and removes deleted cache entries", async () => {
    const f = fixture("{partial");
    expect((await f.service.listHistory(request)).items[0].title).toBe("Gemini conversation");
    f.promises.readdir.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    expect(await f.service.listHistory(request)).toEqual({ items: [], errors: [], nextCursor: null });
    await f.service.listHistory(request);
    expect(f.promises.readFile).toHaveBeenCalledTimes(2);
    f.promises.stat.mockResolvedValue({ size: 1, mtimeMs: 2 });
    f.promises.readFile.mockRejectedValueOnce(new Error("read failure"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await f.service.listHistory(request)).errors).toEqual([{ provider: "gemini", message: "Gemini history is unavailable." }]);
    } finally { log.mockRestore(); }
  });

  it("keeps heartbeats running across 500 files / 1050 MiB and reuses unchanged metadata", async () => {
    const text = JSON.stringify({ sessionId: "acp", startTime: 10, lastUpdated: 20, messages: [
      { id: "u", type: "user", content: "Question", timestamp: 10 },
      { id: "a", type: "gemini", content: "x".repeat(Math.round(2.1 * 1024 ** 2)), timestamp: 20 }
    ] });
    const f = fixture(text, 500);
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
    let first;
    try {
      first = await f.service.listHistory(request);
      maxGap = Math.max(maxGap, performance.now() - previous);
    } finally { clearInterval(timer); }
    expect(first.errors).toEqual([]);
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    expect(f.promises.readFile).toHaveBeenCalledTimes(500);
    expect(beats).toBeGreaterThan(10);
    expect(maxGap).toBeLessThan(200);
    const elapsedMs = performance.now() - started;
    const next = await f.service.listHistory({ ...request, cursor: first.nextCursor });
    expect(next.items).toHaveLength(20);
    expect(next.items.map(item => item.ref).some(ref => first.items.some(item => item.ref === ref))).toBe(false);
    const refreshed = await f.service.listHistory(request);
    expect(refreshed).toEqual(first);
    expect(await f.service.listHistory({ ...request, cursor: refreshed.nextCursor })).toEqual(next);
    expect(f.promises.readFile).toHaveBeenCalledTimes(500);
    console.info(JSON.stringify({ MiB: Buffer.byteLength(text) * 500 / 1024 ** 2, elapsedMs, beats, maxGapMs: maxGap, refreshReads: 0 }));
  }, 15000);
});
