import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createConversationArchiveStore } = require("./conversation-archive-store.cjs");
const { createConversationArchiveService } = require("./conversation-archive-service.cjs");
const { createAgentConversationHistoryService } = require("./agent-conversation-history-service.cjs");
const directories = [];
const closers = [];
function fixture() {
  const userData = mkdtempSync(path.join(tmpdir(), "conversation-archive-"));
  directories.push(userData);
  return userData;
}
const session = { id: "panel", agentProvider: "codex", title: "Task", cwd: "C:\\work", type: "windows", runtimeMode: "app-server" };
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("local conversation archive", () => {
  it("saves only terminal deltas across pages and threads, and retries failed writes", async () => {
    const store = createConversationArchiveStore({ userData: fixture(), now: () => 1000 });
    const save = vi.spyOn(store, "save");
    const messages = [
      { id: "shared", provider: "codex", kind: "reply", text: "first", timestamp: 1001 },
      { id: "second", provider: "codex", kind: "user", text: "second", timestamp: 1002 }
    ];
    const history = {
      async listHistoryForSession() { return { items: [{ ref: "codex:a" }, { ref: "codex:b" }], nextCursor: null }; },
      async getHistoryMessagesForSession(_, { conversationRef, cursor }) {
        if (conversationRef === "codex:b") return { messages: [{ ...messages[0], text: "other thread" }], nextCursor: null };
        return { messages: [{ ...messages[Number(cursor || 0)] }], nextCursor: cursor ? null : "1" };
      }
    };
    const archive = createConversationArchiveService({ store, getHistoryService: () => history, now: () => 1000 });
    closers.push(() => archive.shutdown());
    archive.start({ ...session, runtimeMode: "terminal" });
    archive.bindThread("panel", "codex", "a");
    await archive.flush();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][2].map(message => message.id)).toEqual(["shared", "second"]);
    save.mockClear();
    messages[0].item = { type: "agentMessage", raw: "not persisted" };
    await archive.flush();
    expect(save).not.toHaveBeenCalled();
    messages[1] = { ...messages[1], id: "new", timestamp: 1003 };
    await archive.flush();
    expect(save.mock.calls[0][2].map(message => message.id)).toEqual(["new"]);
    save.mockClear();
    // Mutate the source object to ensure cached values are independent snapshots.
    messages[0].text = "updated";
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      save.mockImplementationOnce(() => { throw new Error("disk full"); });
      await archive.flush();
      expect(archive.list({ scope: "all" }).errors[0].message).toContain("disk full");
      await archive.flush();
      expect(save).toHaveBeenCalledTimes(2);
      expect(save.mock.calls.map(call => call[2].map(message => message.text))).toEqual([["updated"], ["updated"]]);
      expect(archive.list({ scope: "all" }).errors).toEqual([]);
    } finally { errorLog.mockRestore(); }
    save.mockClear();
    await archive.flush();
    expect(save).not.toHaveBeenCalled();
    archive.bindThread("panel", "codex", "b");
    await archive.flush();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][1]).toBe("codex:b");
    const ref = archive.list({ scope: "all" }).items[0].ref;
    expect(archive.read({ conversationRef: ref }).messages.map(message => message.text)).toEqual([
      "other thread", "second", "second", "updated"
    ]);
  });
  it("persists actual compaction summaries and keeps their position across updates and restart", () => {
    const userData = fixture();
    const archive = createConversationArchiveService({ userData, getHistoryService: () => null, now: () => 1000 });
    archive.start(session);
    archive.baseline("panel", { threadId: "thread", items: [] });
    archive.graphical("panel", { threadId: "thread", items: [
      { id: "status", type: "contextCompaction", status: "completed" },
      { id: "summary", type: "contextCompaction", compactionSummary: [{ type: "text", text: "## 摘要" }] },
      { id: "reply", type: "agentMessage", text: "继续处理" }
    ] });
    archive.graphical("panel", { threadId: "thread", items: [
      { id: "summary", type: "contextCompaction", compactionSummary: [{ type: "text", text: "## 摘要" }, { type: "text", text: "进度" }] }
    ] });
    archive.finish("panel");
    const ref = archive.list({ scope: "all" }).items[0].ref;
    archive.shutdown();
    const store = createConversationArchiveStore({ userData });
    closers.push(() => store.close());
    const newest = store.read({ conversationRef: ref, limit: 1 });
    expect(newest.messages[0].text).toBe("继续处理");
    expect(store.read({ conversationRef: ref, cursor: newest.nextCursor }).messages).toEqual([
      expect.objectContaining({ kind: "summary", text: "## 摘要\n\n进度", timestamp: 1000 })]);
  });
  it("migrates existing payloads once without changing launch recency", () => {
    const userData = fixture();
    const store = createConversationArchiveStore({ userData, now: () => 1000 });
    const id = store.start(session);
    store.close();
    const { DatabaseSync } = require("node:sqlite");
    let db = new DatabaseSync(path.join(userData, "agent-conversations.sqlite3"));
    db.exec("DELETE FROM archive_migrations");
    const insert = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)");
    insert.run(id, "thread", "answer", 1, JSON.stringify({ id: "answer", kind: "reply", text: "answer", timestamp: 2, item: { type: "agentMessage", raw: "secret" } }));
    insert.run(id, "thread", "tool", 2, JSON.stringify({ id: "tool", kind: "tool", text: "secret" }));
    insert.run(id, "thread", "progress", 3, JSON.stringify({ id: "progress", kind: "reply", text: "progress", item: { type: "agentMessage", phase: "commentary" } }));
    db.close();
    for (let i = 0; i < 2; i++) {
      const reopened = createConversationArchiveStore({ userData, now: () => 1000 });
      expect(reopened.read({ conversationRef: `archive:${id}` }).messages).toEqual([
        expect.objectContaining({ text: "answer" })]);
      expect(reopened.read({ conversationRef: `archive:${id}` }).messages[0].item).toBeUndefined();
      expect(reopened.list({ scope: "all" }).items[0].updatedAt).toBe(1000);
      reopened.close();
    }
  });

  it("rolls back migration if an existing row is corrupt", () => {
    const userData = fixture();
    const store = createConversationArchiveStore({ userData });
    const id = store.start(session); store.close();
    const { DatabaseSync } = require("node:sqlite");
    const file = path.join(userData, "agent-conversations.sqlite3");
    let db = new DatabaseSync(file);
    db.exec("DELETE FROM archive_migrations");
    const insert = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)");
    insert.run(id, "t", "tool", 1, JSON.stringify({ id: "tool", kind: "tool", text: "output" }));
    insert.run(id, "t", "bad", 2, "invalid"); db.close();
    expect(() => createConversationArchiveStore({ userData })).toThrow();
    db = new DatabaseSync(file);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get().count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM archive_migrations").get().count).toBe(0);
    db.close();
  });

  it("queries saved history without a running panel or remote transport", async () => {
    const archive = { list: vi.fn(() => ({ items: [], nextCursor: null, errors: [] })), read: vi.fn(() => ({ messages: [], nextCursor: null })) };
    const terminalManager = { getSession: vi.fn(() => { throw new Error("offline"); }) };
    const history = createAgentConversationHistoryService({ terminalManager, conversationArchive: archive });
    await history.listHistory({ source: "archive", scope: "all" });
    await history.getHistoryMessages({ conversationRef: "archive:00000000-0000-0000-0000-000000000000" });
    expect(terminalManager.getSession).not.toHaveBeenCalled();
    expect(archive.list).toHaveBeenCalledOnce();
    expect(archive.read).toHaveBeenCalledOnce();
  });
  it("retains independent launches, stream updates and stable message pages across restart", () => {
    const userData = fixture();
    let store = createConversationArchiveStore({ userData, now: () => 1000 });
    const first = store.start(session);
    const second = store.start(session);
    store.associate(first, "cli-1");
    store.save(first, "cli-1", [{ id: "m", kind: "reply", text: "partial", timestamp: 1000 }]);
    store.save(first, "cli-1", [{ id: "m", kind: "reply", text: "complete", timestamp: 1000 }]);
    store.save(first, "cli-2", [{ id: "m", kind: "reply", text: "other thread", timestamp: 1000 }]);
    store.finish(first);
    store.close();
    store = createConversationArchiveStore({ userData });
    closers.push(() => store.close());
    const rows = store.list({ scope: "all" }).items;
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.ref === `archive:${second}`).status).toBe("interrupted");
    expect(rows.find(row => row.ref === `archive:${first}`).threadIds).toEqual(["cli-1", "cli-2"]);
    const page = store.read({ conversationRef: `archive:${first}`, limit: 1 });
    expect(page.messages[0].text).toBe("other thread");
    expect(store.read({ conversationRef: `archive:${first}`, cursor: page.nextCursor }).messages[0].text).toBe("complete");
    expect(store.list({ cwd: "c:/WORK", windows: true, providers: ["codex"], limit: 1 }).nextCursor).toBe("1");
    expect(store.list({ query: "missing", scope: "all" }).items).toEqual([]);
    expect(() => store.read({ conversationRef: "archive:../../x" })).toThrow();
  });

  it("excludes replayed history, rejects tools and reasoning, and updates streamed messages", () => {
    const userData = fixture();
    const archive = createConversationArchiveService({ userData, getHistoryService: () => null, now: () => 1000 });
    closers.push(() => archive.shutdown());
    archive.start(session);
    const old = { id: "old", type: "agentMessage", text: "old history" };
    archive.graphical("panel", { threadId: "thread", items: [old] });
    archive.baseline("panel", { threadId: "thread", items: [old] });
    archive.graphical("panel", { threadId: "thread", items: [old, { id: "new", type: "agentMessage", text: "partial" },
      { id: "reason", type: "reasoning", summary: ["thought"] }, { id: "tool", type: "commandExecution", command: "pwd", aggregatedOutput: "C:/work" }] });
    archive.graphical("panel", { threadId: "thread", items: [{ id: "new", type: "agentMessage", text: "complete" }] });
    archive.pause("panel");
    archive.graphical("panel", { threadId: "thread", items: [{ id: "replayed", type: "agentMessage", text: "replay" }] });
    archive.finish("panel");
    const row = archive.list({ scope: "all" }).items[0];
    const messages = archive.read({ conversationRef: row.ref }).messages;
    expect(messages).toHaveLength(1);
    expect(messages.map(message => message.text)).toEqual(["complete"]);
    expect(messages[0].item).toBeUndefined();
    expect(row.status).toBe("ended");
  });

  it("captures only the bound CLI thread and messages from this launch, including final reread", async () => {
    const userData = fixture();
    let answer = "partial";
    const history = {
      listHistoryForSession: vi.fn(async () => ({ items: [{ ref: "codex:bound", updatedAt: 1000 }, { ref: "codex:unrelated", updatedAt: 1000 }], errors: [], nextCursor: null })),
      getHistoryMessagesForSession: vi.fn(async () => ({ messages: [{ id: "old", kind: "user", text: "before launch", timestamp: 1 }, { id: "new", kind: "final", text: answer, timestamp: 1001 }], nextCursor: null }))
    };
    const archive = createConversationArchiveService({ userData, getHistoryService: () => history, now: () => 1000 });
    closers.push(() => archive.shutdown());
    archive.start({ ...session, runtimeMode: "terminal" });
    archive.bindThread("panel", "codex", "bound");
    await vi.waitFor(() => expect(history.getHistoryMessagesForSession).toHaveBeenCalled());
    const ref = archive.list({ scope: "all" }).items[0].ref;
    await vi.waitFor(() => expect(archive.read({ conversationRef: ref }).messages).toHaveLength(1));
    answer = "final";
    archive.finish("panel");
    await vi.waitFor(() => expect(archive.read({ conversationRef: ref }).messages[0].text).toBe("final"));
    expect(history.getHistoryMessagesForSession.mock.calls.every(call => call[1].conversationRef === "codex:bound")).toBe(true);
  });

  it("records unsupported CLI launches and does not throw on write failure", () => {
    const userData = fixture();
    const archive = createConversationArchiveService({ userData, getHistoryService: () => null });
    closers.push(() => archive.shutdown());
    archive.start({ ...session, agentProvider: "copilot", runtimeMode: "terminal" });
    expect(archive.list({ scope: "all" }).items[0].captureStatus).toBe("unsupported");
    const store = { start: () => { throw new Error("disk full"); }, list: () => ({ items: [], errors: [] }), close: () => {} };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = createConversationArchiveService({ store, getHistoryService: () => null });
    expect(() => failing.start(session)).not.toThrow();
    expect(failing.list({}).errors[0].message).toContain("disk full");
    failing.shutdown(); errorLog.mockRestore();
  });
});
