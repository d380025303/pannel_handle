// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversationAppend, AgentConversationSnapshot } from "../vite-env";
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

  let emitAppend: (value: AgentConversationAppend) => void;

  beforeEach(() => {
    Object.defineProperty(window, "agentConversationApi", {
      configurable: true,
      value: {
        setActiveSession: vi.fn(),
        getSnapshot: vi.fn().mockResolvedValue(snapshot("panel-1", ["old"])),
        onAppend: vi.fn(callback => { emitAppend = callback; return vi.fn(); }),
        onSnapshot: vi.fn((callback) => {
          emitSnapshot = callback;
          return vi.fn();
        }),
        openExternal: vi.fn()
      }
    });
  });

  afterEach(cleanup);

  it("replays appends received during initial loading without duplicates", async () => {
    let resolve!: (value: AgentConversationSnapshot) => void;
    vi.mocked(window.agentConversationApi.getSnapshot).mockReturnValue(new Promise(done => { resolve = done; }));
    const { result } = renderHook(() => useAgentConversation("panel-1", true));
    act(() => emitAppend({ sessionId: "panel-1", startIndex: 1, messages: snapshot("panel-1", ["new", "last"]).turn!.messages }));
    await act(async () => resolve(snapshot("panel-1", ["old", "new"])));
    expect(result.current.snapshot?.turn?.messages.map(message => message.id)).toEqual(["old", "new", "last"]);
  });

  it("buffers hidden appends, ignores other sessions and merges in order when opened", async () => {
    const { result, rerender } = renderHook(({ visible }) => useAgentConversation("panel-1", visible), { initialProps: { visible: false } });
    await waitFor(() => expect(result.current.snapshot?.turn?.messages).toHaveLength(1));
    const previous = result.current.snapshot;
    const messages = snapshot("panel-1", ["new", "last"]).turn!.messages;
    act(() => {
      emitAppend({ sessionId: "other", startIndex: 1, messages });
      emitAppend({ sessionId: "panel-1", startIndex: 1, messages });
      emitAppend({ sessionId: "panel-1", startIndex: 1, messages });
    });
    expect(result.current.snapshot).toBe(previous);
    expect(previous?.turn?.messages).toHaveLength(1);
    expect(result.current.unread).toBe(true);
    rerender({ visible: true });
    expect(result.current.snapshot?.turn?.messages.map(message => message.id)).toEqual(["old", "new", "last"]);
    expect(result.current.unread).toBe(false);
    act(() => emitAppend({ sessionId: "panel-1", startIndex: 3, messages: snapshot("panel-1", ["visible"]).turn!.messages }));
    expect(result.current.snapshot?.turn?.messages.at(-1)?.id).toBe("visible");
  });

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
