// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexAppServerSession } from "./CodexAppServerSession";
import type { CodexAppServerSnapshot } from "../../vite-env";

vi.mock("./OpenCodeAuthDialog", () => ({ OpenCodeAuthDialog: () => <div role="dialog" aria-label="登录 OpenCode">登录终端</div> }));
const snapshot: CodexAppServerSnapshot = { provider: "opencode", threadId: null, mode: "default", executionPermission: "askApproval",
  busy: false, error: "OpenCode 需要登录", pendingPlan: null, items: [], approvals: [],
  acpAuth: { status: "idle", generation: 0, error: null, required: true, methods: [{ id: "opencode-login", name: "Login", description: "" }] } };
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: {
    snapshot: vi.fn().mockResolvedValue(snapshot), onChanged: () => () => {}, onDelta: () => () => {}
  } });
  Object.defineProperty(window, "openCodeVersionApi", { configurable: true, value: { check: vi.fn().mockResolvedValue({ status: "current", currentVersion: "2.0.18" }) } });
});
afterEach(cleanup);

it("offers login before an ACP thread exists", async () => {
  render(<CodexAppServerSession sessionId="one" draft="" setDraft={vi.fn()} />);
  await screen.findByText("OpenCode 需要登录");
  const menu = screen.getByRole("button", { name: "更多操作" });
  expect(menu).toHaveProperty("disabled", false); fireEvent.click(menu);
  fireEvent.click(screen.getByRole("menuitem", { name: "登录 OpenCode" }));
  expect(screen.getByRole("dialog", { name: "登录 OpenCode" })).toBeTruthy();
});

it.each([{ busy: true }, { pendingPlan: { itemId: "plan" } }, { approvals: [{ requestId: 1, method: "session/request_permission", params: {} }] }])
  ("disables login while another interaction is pending %j", async pending => {
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValue({ ...snapshot, threadId: "original", ...pending } as CodexAppServerSnapshot);
    render(<CodexAppServerSession sessionId="one" draft="" setDraft={vi.fn()} />);
    await screen.findByText("OpenCode 需要登录");
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "登录 OpenCode" })).toHaveProperty("disabled", true);
  });
