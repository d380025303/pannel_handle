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
      "agent-conversation:snapshot",
      expect.objectContaining({ turn: expect.objectContaining({ messages: [expect.objectContaining({ id: "one" })] }) })
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
