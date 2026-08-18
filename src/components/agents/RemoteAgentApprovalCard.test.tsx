// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { RemoteAgentApprovalRequest, TerminalSession } from "../../vite-env";
import { RemoteAgentApprovalCard } from "./RemoteAgentApprovalCard";

const request: RemoteAgentApprovalRequest = {
  id: "approval-1",
  sessionId: "run-1",
  tool: "remote_exec",
  summary: "git status --short",
  timestamp: 100
};

const session: TerminalSession = {
  id: "run-1",
  title: "Production SSH",
  shell: "ssh",
  cwd: "/srv/app",
  createdAt: 1,
  type: "ssh",
  agentLocation: "local"
};

const listPendingApprovals = vi.fn(async () => [request]);
const resolveApproval = vi.fn(async () => true);
let requestedListener: ((payload: RemoteAgentApprovalRequest) => void) | undefined;
let resolvedListener: ((payload: { id: string; decision: "once" | "session" | "deny" }) => void) | undefined;

describe("RemoteAgentApprovalCard", () => {
  afterEach(cleanup);

  beforeEach(() => {
    listPendingApprovals.mockClear();
    resolveApproval.mockClear();
    requestedListener = undefined;
    resolvedListener = undefined;
    Object.defineProperty(window, "remoteAgentApi", {
      configurable: true,
      value: {
        listPendingApprovals,
        resolveApproval,
        listAudit: vi.fn(async () => []),
        onAudit: vi.fn(() => () => undefined),
        onApprovalRequested: vi.fn((callback) => {
          requestedListener = callback;
          return () => undefined;
        }),
        onApprovalResolved: vi.fn((callback) => {
          resolvedListener = callback;
          return () => undefined;
        })
      }
    });
  });

  it("shows a compact in-app request without a blocking overlay or stolen focus", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    render(<I18nProvider locale="en-US"><RemoteAgentApprovalCard sessions={[session]} /></I18nProvider>);

    expect(await screen.findByText("git status --short")).toBeTruthy();
    expect(screen.getByText("From Production SSH")).toBeTruthy();
    expect(document.querySelector(".modal-overlay")).toBeNull();
    expect(document.activeElement).toBe(input);

    fireEvent.click(screen.getByRole("button", { name: "Allow for session" }));
    await waitFor(() => expect(resolveApproval).toHaveBeenCalledWith("approval-1", "session"));
    await waitFor(() => expect(screen.queryByText("git status --short")).toBeNull());
    input.remove();
  });

  it("queues new requests and removes requests resolved by the main process", async () => {
    listPendingApprovals.mockResolvedValueOnce([]);
    render(<I18nProvider locale="en-US"><RemoteAgentApprovalCard sessions={[session]} /></I18nProvider>);
    await waitFor(() => expect(requestedListener).toBeTypeOf("function"));

    requestedListener?.(request);
    expect(await screen.findByText("git status --short")).toBeTruthy();
    resolvedListener?.({ id: request.id, decision: "deny" });
    await waitFor(() => expect(screen.queryByText("git status --short")).toBeNull());
  });
});
