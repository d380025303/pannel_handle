// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversationSnapshot } from "../vite-env";
import { useAgentConversation } from "./useAgentConversation";

function snapshot(sessionId: string, messageIds: string[] = []): AgentConversationSnapshot {
  return {
    activeSessionId: sessionId,
    turn: {
      sessionId,
      sessionTitle: sessionId,
      provider: "codex",
      status: "running",
      supported: true,
      messages: messageIds.map((id, index) => ({
        id,
        provider: "codex",
        kind: "commentary",
        text: id,
        timestamp: index
      }))
    }
  };
}

describe("useAgentConversation", () => {
  let emitSnapshot: (value: AgentConversationSnapshot) => void = () => undefined;

  beforeEach(() => {
    Object.defineProperty(window, "agentConversationApi", {
      configurable: true,
      value: {
        setActiveSession: vi.fn(),
        getSnapshot: vi.fn().mockResolvedValue(snapshot("panel-1", ["old"])),
        onSnapshot: vi.fn((callback) => {
          emitSnapshot = callback;
          return vi.fn();
        }),
        openExternal: vi.fn()
      }
    });
  });

  afterEach(cleanup);

  it("does not mark initial or switched-session history as unread", async () => {
    const { result } = renderHook(() => useAgentConversation("panel-1", false));
    await waitFor(() => expect(result.current.snapshot?.activeSessionId).toBe("panel-1"));
    expect(result.current.unread).toBe(false);

    act(() => emitSnapshot(snapshot("panel-2", ["existing"])));
    expect(result.current.unread).toBe(false);
  });

  it("marks new messages without stealing visibility and clears when opened", async () => {
    const { result, rerender } = renderHook(
      ({ visible }) => useAgentConversation("panel-1", visible),
      { initialProps: { visible: false } }
    );
    await waitFor(() => expect(result.current.snapshot?.activeSessionId).toBe("panel-1"));

    act(() => emitSnapshot(snapshot("panel-1", ["old", "new"])));
    expect(result.current.unread).toBe(true);

    rerender({ visible: true });
    expect(result.current.unread).toBe(false);

    act(() => emitSnapshot(snapshot("panel-1", ["old", "new", "visible-message"])));
    expect(result.current.unread).toBe(false);
  });
});
