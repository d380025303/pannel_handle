import { describe, expect, it, vi } from "vitest";
import historyModule from "./agent-conversation-history-service.cjs";
import archiveModule from "./conversation-archive-service.cjs";

const session = { id: "panel", type: "windows", cwd: "C:\\work", agentProvider: "codex", runtimeMode: "terminal" };
function fixture(count = 4) {
  const line = index => JSON.stringify({ type: "response_item", timestamp: 1000 + index,
    payload: { id: `m${index}`, type: "message", role: "user",
      content: [{ type: "input_text", text: "x".repeat(1800) }] } });
  let text = Array.from({ length: count }, (_, index) => line(index)).join("\n");
  const readFileSync = vi.fn(() => text);
  class Database {
    function() {}
    close() {}
    prepare() { return { get: () => ({ rollout_path: "rollout.jsonl" }),
      all: () => [{ id: "bound", cwd: session.cwd, title: "Task", created_at: 1, updated_at: 2 }] }; }
  }
  const history = historyModule.createAgentConversationHistoryService({ homeDir: "fixture",
    fsApi: { existsSync: () => true, readFileSync }, Database });
  const read = (cursor = null, activeSession = session, ref = "codex:bound") =>
    history.getHistoryMessagesForSession(activeSession, { conversationRef: ref, cursor, limit: 2 });
  return { history, read, readFileSync, append: () => { text += `\n${line(count++)}`; } };
}

describe("local message snapshots", () => {
  it("keeps pagination stable during append and refreshes on every first page", async () => {
    const f = fixture();
    expect((await f.read()).messages.map(m => m.id)).toEqual(["m3", "m2"]);
    f.append();
    expect((await f.read("2")).messages.map(m => m.id)).toEqual(["m1", "m0"]);
    expect(f.readFileSync).toHaveBeenCalledTimes(1);
    expect((await f.read("0")).messages[0].id).toBe("m4");
    expect(f.readFileSync).toHaveBeenCalledTimes(2);
    await expect(f.read("invalid")).rejects.toThrow("cursor");
    expect(f.readFileSync).toHaveBeenCalledTimes(2);
  });

  it("expires snapshots, bounds capacity, and isolates session and conversation keys", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const f = fixture();
      await f.read();
      await f.read("2");
      expect(f.readFileSync).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(31000);
      await f.read("2");
      expect(f.readFileSync).toHaveBeenCalledTimes(2);
      await f.read("2", { ...session, id: "other" });
      await f.read("2", session, "codex:other");
      await f.read("2");
      expect(f.readFileSync).toHaveBeenCalledTimes(5);
    } finally { clock.mockRestore(); }
  });

  it("archives 10,000 messages with one full read per poll and captures appended messages", async () => {
    const f = fixture(10000);
    const saved = new Map();
    const store = { start: () => "archive", associate() {}, captureStatus() {}, finish() {}, close() {},
      save: (_id, _ref, messages) => { for (const message of messages) saved.set(message.id, message); } };
    const archive = archiveModule.createConversationArchiveService({ store, now: () => 1000,
      getHistoryService: () => f.history });
    try {
      archive.start(session);
      archive.bindThread(session.id, "codex", "bound");
      await vi.waitFor(() => expect(saved.size).toBe(10000));
      expect(f.readFileSync).toHaveBeenCalledTimes(1);
      f.append();
      await archive.flush();
      expect(saved.size).toBe(10001);
      expect(saved.has("m10000")).toBe(true);
      expect(f.readFileSync).toHaveBeenCalledTimes(2);
    } finally { archive.shutdown(); }
  });
});
