import { afterEach, describe, expect, it, vi } from "vitest";
import historyModule from "./agent-conversation-history-service.cjs";
import archiveModule from "./conversation-archive-service.cjs";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const directories = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const session = { id: "panel", type: "windows", cwd: "C:\\work", agentProvider: "codex", runtimeMode: "terminal" };
function fixture(count = 4) {
  const line = index => JSON.stringify({ type: "response_item", timestamp: 1000 + index,
    payload: { id: `m${index}`, type: "message", role: "user",
      content: [{ type: "input_text", text: "x".repeat(1800) }] } });
  let text = Array.from({ length: count }, (_, index) => line(index)).join("\n");
  let ino = 1;
  let version = 1;
  const readFile = vi.fn(async () => text);
  const stat = vi.fn(async () => ({ dev: 1, ino, size: Buffer.byteLength(text), mtimeMs: version, ctimeMs: version }));
  class Database {
    function() {}
    close() {}
    prepare() { return { get: () => ({ rollout_path: "rollout.jsonl" }),
      all: () => [{ id: "bound", cwd: session.cwd, title: "Task", created_at: 1, updated_at: 2 }] }; }
  }
  // List reads now happen in a Worker; message reads retain the focused transcript mocks.
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-snapshot-"));
  directories.push(homeDir);
  fs.mkdirSync(path.join(homeDir, ".codex"));
  const database = new DatabaseSync(path.join(homeDir, ".codex", "state_5.sqlite"));
  database.exec(`CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, created_at INTEGER,
    updated_at INTEGER, archived INTEGER, first_user_message TEXT, preview TEXT, source TEXT,
    recency_at_ms INTEGER, updated_at_ms INTEGER)`);
  database.prepare("INSERT INTO threads VALUES (?, ?, 'Task', 1, 2, 0, 'question', '', 'cli', 2, 2)").run("bound", session.cwd);
  database.close();
  const history = historyModule.createAgentConversationHistoryService({ homeDir,
    fsApi: { existsSync: () => true, promises: { readFile, stat } }, Database });
  const read = (cursor = null, activeSession = session, ref = "codex:bound") =>
    history.getHistoryMessagesForSession(activeSession, { conversationRef: ref, cursor, limit: 2 });
  return { history, read, readFile, stat,
    append: () => { text += `\n${line(count++)}`; version++; },
    truncate: () => { text = line(0); version++; },
    replace: () => { text = line(9); ino++; } };
}

describe("local message snapshots", () => {
  it("does not cache a transcript changed during its read", async () => {
    const f = fixture();
    f.readFile.mockImplementationOnce(async () => { f.append(); return ""; });
    expect((await f.read()).messages).toEqual([]);
    expect((await f.read()).messages[0].id).toBe("m4");
    expect(f.readFile).toHaveBeenCalledTimes(2);
  });

  it("refreshes truncated and replaced files and invalidates failed reads", async () => {
    const f = fixture();
    await f.read();
    f.truncate();
    expect((await f.read()).messages.map(m => m.id)).toEqual(["m0"]);
    f.replace();
    expect((await f.read()).messages.map(m => m.id)).toEqual(["m9"]);
    expect(f.readFile).toHaveBeenCalledTimes(3);
    f.stat.mockRejectedValueOnce(new Error("missing"));
    await expect(f.read()).rejects.toThrow("missing");
    await f.read();
    expect(f.readFile).toHaveBeenCalledTimes(4);
  });

  it("keeps pagination stable during append and refreshes on every first page", async () => {
    const f = fixture();
    expect((await f.read()).messages.map(m => m.id)).toEqual(["m3", "m2"]);
    f.append();
    expect((await f.read("2")).messages.map(m => m.id)).toEqual(["m1", "m0"]);
    expect(f.readFile).toHaveBeenCalledTimes(1);
    expect((await f.read("0")).messages[0].id).toBe("m4");
    expect(f.readFile).toHaveBeenCalledTimes(2);
    await expect(f.read("invalid")).rejects.toThrow("cursor");
    expect(f.readFile).toHaveBeenCalledTimes(2);
  });

  it("expires snapshots, bounds capacity, and isolates session and conversation keys", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const f = fixture();
      await f.read();
      await f.read("2");
      expect(f.readFile).toHaveBeenCalledTimes(1);
      expect(f.stat).toHaveBeenCalledTimes(2);
      clock.mockReturnValue(31000);
      await f.read("2");
      expect(f.readFile).toHaveBeenCalledTimes(1);
      await f.read("2", { ...session, id: "other" });
      await f.read("2", session, "codex:other");
      await f.read("2");
      expect(f.readFile).toHaveBeenCalledTimes(1);
      expect(f.stat).toHaveBeenCalledTimes(6);
    } finally { clock.mockRestore(); }
  });

  it("reuses unchanged transcripts across archive polls and captures appended messages", async () => {
    const f = fixture(10000);
    const saved = new Map();
    const pages = vi.spyOn(f.history, "getHistoryMessagesForSession");
    const store = { start: () => "archive", associate() {}, captureStatus() {}, finish() {}, close() {},
      save: (_id, _ref, messages) => { for (const message of messages) saved.set(message.id, message); } };
    const archive = archiveModule.createConversationArchiveService({ store, now: () => 1000,
      getHistoryService: () => f.history });
    try {
      archive.start(session);
      archive.bindThread(session.id, "codex", "bound");
      await vi.waitFor(() => expect(saved.size).toBe(10000));
      expect(f.readFile).toHaveBeenCalledTimes(1);
      pages.mockClear();
      await archive.flush();
      await archive.flush();
      expect(pages).not.toHaveBeenCalled();
      expect(f.readFile).toHaveBeenCalledTimes(1);
      f.append();
      await archive.flush();
      expect(saved.size).toBe(10001);
      expect(saved.has("m10000")).toBe(true);
      expect(f.readFile).toHaveBeenCalledTimes(2);
    } finally { archive.shutdown(); }
  });
});
