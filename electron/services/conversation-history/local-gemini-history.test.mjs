import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { performance } from "node:perf_hooks";
import historyModule from "./agent-conversation-history-service.cjs";
import geminiModule from "./local-gemini-history.cjs";
import archiveModule from "./conversation-archive-service.cjs";

function fixture(text, count = 1, extension = "json") {
  const cwd = "C:\\current";
  const hash = geminiModule.geminiProjectHash(cwd);
  const root = path.join(process.env.GEMINI_CLI_HOME || "fixture", ".gemini", "tmp");
  const size = Buffer.byteLength(text);
  const promises = {
    readdir: vi.fn(async candidate => candidate === root
      ? [{ name: hash, isDirectory: () => true }]
      : Array.from({ length: count }, (_, index) => ({ name: `session-${index}.${extension}`, isFile: () => true }))),
    stat: vi.fn(async () => ({ size, mtimeMs: 123 })),
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

  it("reuses concurrent first pages, preserves pagination, and refreshes changed files", async () => {
    const f = fixture(JSON.stringify({ messages: [
      { id: "u", type: "user", content: " Question ", timestamp: 10 },
      { id: "a", type: "gemini", content: "Answer", timestamp: 20 }
    ] }));
    const input = { panelSessionId: "run", conversationRef: `gemini:${f.hash}:session-0`, limit: 1 };
    const [first, duplicate] = await Promise.all([f.service.getHistoryMessages(input), f.service.getHistoryMessages(input)]);
    expect(duplicate).toEqual(first);
    expect(first.messages[0]).toMatchObject({ id: "a", text: "Answer", kind: "reply" });
    expect((await f.service.getHistoryMessages({ ...input, cursor: first.nextCursor })).messages[0]).toMatchObject({ id: "u", text: "Question", kind: "user" });
    expect(await f.service.getHistoryMessages(input)).toEqual(first);
    expect(f.promises.readFile).toHaveBeenCalledTimes(1);
    f.promises.stat.mockResolvedValue({ size: 100, mtimeMs: 124 });
    f.promises.readFile.mockResolvedValue(JSON.stringify({ messages: [{ id: "new", type: "user", content: "Changed", timestamp: 30 }] }));
    expect((await f.service.getHistoryMessages(input)).messages[0].id).toBe("new");
    expect(f.promises.readFile).toHaveBeenCalledTimes(2);
  });

  it("evicts bounded snapshots, retries failures, and avoids caching files changed during parsing", async () => {
    const f = fixture(JSON.stringify({ messages: [{ id: "u", type: "user", content: "Text" }] }), 3);
    const cache = new Map();
    const input = { homeDir: "fixture", cwd: f.cwd, fsApi: { promises: f.promises }, messageCache: cache };
    const read = index => geminiModule.getLocalGeminiMessages({ ...input, id: `${f.hash}:session-${index}` });
    await read(0); await read(1); await read(2);
    expect(cache.size).toBe(2);
    await read(0);
    expect(f.promises.readFile).toHaveBeenCalledTimes(4);
    f.promises.stat.mockResolvedValue({ size: 10, mtimeMs: 1 });
    f.promises.readFile.mockRejectedValueOnce(new Error("failed"));
    await expect(read(0)).rejects.toThrow("failed");
    await read(0);
    f.promises.stat.mockResolvedValueOnce({ size: 11, mtimeMs: 2 }).mockResolvedValue({ size: 12, mtimeMs: 3 });
    await read(0);
    expect(cache.has(path.join(process.env.GEMINI_CLI_HOME || "fixture", ".gemini", "tmp", f.hash, "chats", "session-0.json"))).toBe(false);
    await read(0);
    expect(f.promises.readFile).toHaveBeenCalledTimes(8);
  });

  it("preserves checkpoint and rewind messages through the Worker", async () => {
    const f = fixture([JSON.stringify({ $set: { messages: [
      { id: "u", type: "user", content: "Question", timestamp: 1 },
      { id: "old", type: "gemini", content: "Obsolete", timestamp: 2 }
    ] } }), "{partial", JSON.stringify({ $rewindTo: "old" }), JSON.stringify({ id: "new", type: "gemini", content: "Answer", timestamp: 3 })].join("\n"), 1, "jsonl");
    const result = await f.service.getHistoryMessages({ panelSessionId: "run", conversationRef: `gemini:${f.hash}:session-0`, limit: 100 });
    expect(result.messages.map(item => item.id)).toEqual(["new", "u"]);
  });

  it("archives oldest first across repeated polls without rereading unchanged messages", async () => {
    const f = fixture(JSON.stringify({ messages: Array.from({ length: 250 }, (_, index) => ({
      id: String(index), type: index % 2 ? "gemini" : "user", content: `Text ${index}`, timestamp: index + 1
    })) }));
    const store = { start: () => "archive", associate: vi.fn(), save: vi.fn(), captureStatus: vi.fn(), finish: vi.fn(), close: vi.fn() };
    const archive = archiveModule.createConversationArchiveService({ store, now: () => 0, getHistoryService: () => f.service });
    try {
      archive.start({ id: "run", type: "windows", cwd: f.cwd, agentProvider: "gemini" });
      archive.bindThread("run", "gemini", `${f.hash}:session-0`);
      await archive.flush();
      await archive.flush();
      const messages = store.save.mock.calls.at(-1)[2];
      expect(messages).toHaveLength(250);
      expect(messages.map(item => item.id)).toEqual(Array.from({ length: 250 }, (_, index) => String(index)));
      expect(messages[0].text).toBe("Text 0");
      // One metadata read and one Worker message read for all polls.
      expect(f.promises.readFile).toHaveBeenCalledTimes(2);
    } finally { archive.shutdown(); }
  });

  it("keeps timers running while loading 25000 messages / 50 MiB and reads only once", async () => {
    const text = JSON.stringify({ messages: Array.from({ length: 25000 }, (_, index) => ({
      id: String(index), type: index % 2 ? "gemini" : "user", content: "x".repeat(2048), timestamp: index + 1
    })) });
    const f = fixture(text);
    const input = { panelSessionId: "run", conversationRef: `gemini:${f.hash}:session-0`, limit: 100 };
    // Match real async readFile: return fresh bytes that the Worker can take ownership of.
    f.promises.readFile.mockResolvedValueOnce(Buffer.from(text, "utf-8"));
    let beats = 0;
    let maxGap = 0;
    let previous = performance.now();
    const started = previous;
    const timer = setInterval(() => {
      const current = performance.now();
      maxGap = Math.max(maxGap, current - previous);
      previous = current;
      beats++;
    }, 1);
    try {
      const first = await f.service.getHistoryMessages(input);
      maxGap = Math.max(maxGap, performance.now() - previous);
      expect(first.messages).toHaveLength(100);
      expect(first.messages[0].id).toBe("24999");
      expect((await f.service.getHistoryMessages({ ...input, cursor: first.nextCursor })).messages[0].id).toBe("24899");
      const warmStart = performance.now();
      expect(await f.service.getHistoryMessages(input)).toEqual(first);
      expect(f.promises.readFile).toHaveBeenCalledTimes(1);
      expect(beats).toBeGreaterThan(2);
      expect(maxGap).toBeLessThan(100);
      console.info(JSON.stringify({ messageMiB: Buffer.byteLength(text) / 1024 ** 2, coldMs: warmStart - started, warmMs: performance.now() - warmStart, beats, maxGapMs: maxGap }));
    } finally { clearInterval(timer); }
  }, 15000);

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
    expect(beats).toBeGreaterThan(2);
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
