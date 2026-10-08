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
    store.save(first, "cli-1", [{ id: "m", text: "partial", timestamp: 1000 }]);
    store.save(first, "cli-1", [{ id: "m", text: "complete", timestamp: 1000 }]);
    store.save(first, "cli-2", [{ id: "m", text: "other thread", timestamp: 1000 }]);
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

  it("excludes replayed history, keeps tools and reasoning, and updates streamed messages", () => {
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
    expect(messages).toHaveLength(3);
    expect(messages.map(message => message.text)).toEqual(["pwd\n\nC:/work", "thought", "complete"]);
    expect(messages[0].item.aggregatedOutput).toBe("C:/work");
    expect(row.status).toBe("ended");
  });

  it("captures only the bound CLI thread and messages from this launch, including final reread", async () => {
    const userData = fixture();
    let answer = "partial";
    const history = {
      listHistoryForSession: vi.fn(async () => ({ items: [{ ref: "codex:bound", updatedAt: 1000 }, { ref: "codex:unrelated", updatedAt: 1000 }], errors: [], nextCursor: null })),
      getHistoryMessagesForSession: vi.fn(async () => ({ messages: [{ id: "old", text: "before launch", timestamp: 1 }, { id: "new", text: answer, timestamp: 1001 }], nextCursor: null }))
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
