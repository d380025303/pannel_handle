import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createAgentConversationManager } = require("./agent-conversation-manager.cjs");

function createHarness() {
  const broadcast = vi.fn();
  const manager = createAgentConversationManager({ broadcast });
  return { manager, broadcast };
}

describe("Agent conversation manager", () => {
  it("sends exactly 4,000 records for 4,000 appends and no updates for duplicates", () => {
    const { manager, broadcast } = createHarness();
    manager.setActiveSession("panel-1");
    manager.startTurn({ sessionId: "panel-1", provider: "codex", supported: true });
    broadcast.mockClear();
    const messages = Array.from({ length: 4000 }, (_, i) => ({ id: `m:${i}`, provider: "codex", kind: "commentary", text: `message ${i}`, timestamp: i }));
    for (const message of messages) manager.appendMessages("panel-1", [message]);
    expect(broadcast).toHaveBeenCalledTimes(4000);
    expect(broadcast.mock.calls.reduce((total, [, payload]) => total + payload.messages.length, 0)).toBe(4000);
    expect(broadcast.mock.calls.flatMap(([, payload]) => payload.messages)).toEqual(messages);
    expect(manager.getSnapshot().turn.messages).toEqual(messages);
    broadcast.mockClear();
    manager.appendMessages("panel-1", [...messages, null, { id: "empty", text: "" }]);
    manager.appendMessages("panel-1", []);
    expect(broadcast).not.toHaveBeenCalled();
    manager.startTurn({ sessionId: "panel-1", provider: "codex", supported: true });
    broadcast.mockClear();
    manager.appendMessages("panel-1", messages);
    expect(broadcast).not.toHaveBeenCalled();
    manager.clearSession("panel-1");
    manager.startTurn({ sessionId: "panel-1", provider: "codex", supported: true });
    manager.appendMessages("panel-1", [messages[0]]);
    expect(manager.getSnapshot().turn.messages).toEqual([messages[0]]);
  });

  it("retains a parsed summary between turns without duplicating it", () => {
    const { manager } = createHarness();
    manager.setActiveSession("panel-1");
    manager.startTurn({ sessionId: "panel-1", provider: "codebuddy", supported: true });
    const summary = { id: "summary", provider: "codebuddy", kind: "summary", text: "压缩摘要", timestamp: 1 };
    manager.appendMessages("panel-1", [summary, summary]);
    manager.completeTurn("panel-1");
    manager.startTurn({ sessionId: "panel-1", provider: "codebuddy", supported: true });
    expect(manager.getSnapshot().turn.messages).toEqual([summary]);
  });
  it("adds the submitted user prompt to the live conversation once", () => {
    const { manager } = createHarness();
    manager.setActiveSession("panel-1");
    manager.startTurn({ sessionId: "panel-1", sessionTitle: "Main", provider: "codex", supported: true, userMessage: "Fix the tests", userMessageId: "turn-1", timestamp: 10 });
    manager.startTurn({ sessionId: "panel-1", sessionTitle: "Main", provider: "codex", supported: true, userMessage: "Fix the tests", userMessageId: "turn-1", timestamp: 10 });
    expect(manager.getSnapshot().turn.messages).toEqual([
      { id: "turn-1", provider: "codex", kind: "user", text: "Fix the tests", timestamp: 10 }
    ]);
  });
  it("broadcasts the selected session snapshot without creating a separate window", () => {
    const { manager, broadcast } = createHarness();

    manager.setActiveSession("panel-1");

    expect(broadcast).toHaveBeenLastCalledWith("agent-conversation:snapshot", {
      activeSessionId: "panel-1",
      turn: null
    });
  });

  it("broadcasts live messages for the active session and ignores duplicates", () => {
    const { manager, broadcast } = createHarness();
    manager.setActiveSession("panel-1");
    manager.startTurn({ sessionId: "panel-1", sessionTitle: "Main", provider: "codex", supported: true });
    manager.appendMessages("panel-1", [
      { id: "one", provider: "codex", kind: "commentary", text: "正在检查", timestamp: 1 },
      { id: "one", provider: "codex", kind: "commentary", text: "重复消息", timestamp: 2 }
    ]);

    expect(manager.getSnapshot().turn.messages).toEqual([
      expect.objectContaining({ id: "one", text: "正在检查" })
    ]);
    expect(broadcast).toHaveBeenLastCalledWith(
      "agent-conversation:append",
      { sessionId: "panel-1", startIndex: 0, messages: [expect.objectContaining({ id: "one" })] }
    );
  });

  it("keeps accumulated messages across turns until the session is cleared", () => {
    const { manager } = createHarness();
    manager.setActiveSession("panel-1");
    manager.startTurn({ sessionId: "panel-1", sessionTitle: "Plan", provider: "codex", supported: true });
    manager.appendMessages("panel-1", [{ id: "first", provider: "codex", kind: "final", text: "first reply", timestamp: 1 }]);
    manager.completeTurn("panel-1");

    expect(manager.getSnapshot().turn.status).toBe("completed");
    manager.startTurn({ sessionId: "panel-1", sessionTitle: "Plan", provider: "codex", supported: true });
    expect(manager.getSnapshot().turn).toMatchObject({
      status: "running",
      messages: [expect.objectContaining({ id: "first" })]
    });

    manager.clearSession("panel-1");
    expect(manager.getSnapshot().turn).toBeNull();
  });

  it("adds the Stop reply only when the current turn has no parsed final message", () => {
    const { manager } = createHarness();
    manager.setActiveSession("panel-1");
    manager.startTurn({ sessionId: "panel-1", sessionTitle: "Plan", provider: "codex", supported: true, userMessage: "first" });
    manager.appendMessages("panel-1", [{ id: "progress", provider: "codex", kind: "commentary", text: "working", timestamp: 1 }]);
    manager.completeTurn("panel-1", { id: "stop:first", provider: "codex", text: "first result", timestamp: 2 });
    manager.completeTurn("panel-1", { id: "stop:first-repeat", provider: "codex", text: "first result", timestamp: 3 });

    manager.startTurn({ sessionId: "panel-1", sessionTitle: "Plan", provider: "codex", supported: true, userMessage: "second" });
    manager.appendMessages("panel-1", [{ id: "parsed-final", provider: "codex", kind: "final", text: "second result", timestamp: 4 }]);
    manager.completeTurn("panel-1", { id: "stop:second", provider: "codex", text: "second result", timestamp: 5 });

    const finalMessages = manager.getSnapshot().turn.messages.filter(message => message.kind === "final");
    expect(finalMessages.map(message => [message.id, message.text])).toEqual([
      ["stop:first", "first result"],
      ["parsed-final", "second result"]
    ]);
  });

  it("follows session selection and exposes unsupported remote turns", () => {
    const { manager, broadcast } = createHarness();
    manager.setActiveSession("panel-1");
    manager.startTurn({ sessionId: "panel-2", sessionTitle: "Remote", provider: "codebuddy", supported: false });
    expect(broadcast).toHaveBeenCalledTimes(1);

    manager.setActiveSession("panel-2");
    expect(manager.getSnapshot().turn).toMatchObject({ status: "unsupported", supported: false });
    expect(broadcast).toHaveBeenCalledTimes(2);
  });
});
