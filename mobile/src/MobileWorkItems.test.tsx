import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileWorkItems } from "./MobileWorkItems";
import type { useRemoteConnection } from "./useRemoteConnection";
import type { WorkItemMessage } from "./types";
afterEach(cleanup);
it("correlates responses, ignores stale results and re-queries after reconnect without replaying mutations", async () => {
  let receive: (message: WorkItemMessage) => void = () => {};
  const send = vi.fn((_message: import("./types").ClientMessage) => true);
  const remote = { status: "connected", connectionEpoch: 1, sessions: [], send,
    onSessionMessage: vi.fn(() => () => {}), onWorkItemMessage: (listener: typeof receive) => { receive = listener; return () => {}; }
  } as unknown as ReturnType<typeof useRemoteConnection>;
  const props = { remote, onClose: vi.fn(), onOpenSession: vi.fn() };
  const page = render(<MobileWorkItems {...props} />);
  await waitFor(() => expect(send).toHaveBeenCalled());
  const request = send.mock.calls.at(-1)![0] as unknown as { requestId: string };
  receive({ v: 8, type: "work-items.result", requestId: "stale", result: { records: [], total: 999, templates: [], owners: [] } });
  receive({ v: 8, type: "work-items.result", requestId: request.requestId, result: { records: [], total: 0, templates: [], owners: [] } });
  await screen.findByText("暂无任务");
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  page.rerender(<MobileWorkItems {...props} remote={{ ...remote, status: "disconnected" }} />);
  await screen.findByText("连接中断，请重连后核对任务和执行记录；请求不会自动重发。");
  send.mockClear();
  page.rerender(<MobileWorkItems {...props} remote={{ ...remote, connectionEpoch: 2 }} />);
  await waitFor(() => expect(send).toHaveBeenCalled());
  expect(send.mock.calls.every(call => (call[0] as unknown as { operation: string }).operation === "list")).toBe(true);
});
