import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GraphicalView } from "./GraphicalView";
import type { GraphicalSnapshot, RuntimeSession, ServerMessage } from "./types";

afterEach(cleanup);

const session: RuntimeSession = { id: "graph-1", title: "Agent", type: "windows", runtimeMode: "app-server", agentProvider: "codex" };
const snapshot: GraphicalSnapshot = {
  threadId: "thread-1", provider: "codex", busy: false, archived: false, error: null,
  mode: "default", nativeMode: null, capabilities: { history: true }, pendingPlan: null,
  items: [{ id: "m1", type: "agentMessage", text: "**完成**" }], approvals: [], questions: []
};

function fixture() {
  const send = vi.fn(() => true);
  let listener: ((message: Extract<ServerMessage, { type: "graphical.snapshot" | "graphical.history" | "command.ok" | "error" }>) => void) | undefined;
  render(<GraphicalView session={session} send={send} onGraphicalMessage={callback => { listener = callback; return () => { listener = undefined; }; }} />);
  const emit = (message: Parameters<NonNullable<typeof listener>>[0]) => act(() => { listener?.(message); });
  return { send, emit };
}

it("subscribes to the selected graphical session and sends text with its thread identity", () => {
  const { send, emit } = fixture();
  expect(send).toHaveBeenCalledWith({ v: 2, type: "graphical.subscribe", sessionId: "graph-1" });
  emit({ v: 2, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  expect(screen.getByText("完成")).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("输入消息"), { target: { value: "hello" } });
  fireEvent.click(screen.getByText("发送"));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.submit", sessionId: "graph-1", threadId: "thread-1", text: "hello" }));
});

it("shows current approval choices and ignores another session's snapshot", () => {
  const { send, emit } = fixture();
  emit({ v: 2, type: "graphical.snapshot", sessionId: "other", snapshot });
  expect(screen.queryByText("完成")).toBeNull();
  emit({ v: 2, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, approvals: [{ requestId: "a1", method: "session/request_permission",
      params: { reason: "运行命令", choices: [{ id: "allow_once", label: "允许一次" }, { id: "deny", label: "拒绝" }] } }]
  } });
  fireEvent.click(screen.getByText("允许一次"));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.approval", approvalId: "a1", decision: "allow_once" }));
});
