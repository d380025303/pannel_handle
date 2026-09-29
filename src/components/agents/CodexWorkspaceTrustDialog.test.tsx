// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexWorkspaceTrustRequest } from "../../vite-env";
import { CodexWorkspaceTrustDialog } from "./CodexWorkspaceTrustDialog";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

const request: CodexWorkspaceTrustRequest = {
  id: "run-7", sessionId: "run-7", title: "SSH Codex", workspacePath: "C:\\runtime\\run-7",
  phase: "project", ready: true, terminalOpen: false, configPreview: '{"hooks":{}}', scriptPreview: "Write-Output ready", output: "", error: ""
};

afterEach(cleanup);

it("shows the exact workspace and hook content before granting project trust", async () => {
  const trustProject = vi.fn(async () => request);
  Object.defineProperty(window, "codexWorkspaceTrustApi", { configurable: true, value: {
    listPending: vi.fn(async () => [request]), trustProject, openHooks: vi.fn(), write: vi.fn(), resize: vi.fn(),
    finish: vi.fn(), cancel: vi.fn(), onChanged: vi.fn(() => () => {}), onOutput: vi.fn(() => () => {}),
    onResolved: vi.fn(() => () => {})
  } });
  render(<CodexWorkspaceTrustDialog />);
  expect(await screen.findByText("C:\\runtime\\run-7")).toBeTruthy();
  fireEvent.click(screen.getByText("查看 Hook 配置"));
  expect(screen.getByText('{"hooks":{}}')).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "信任当前工作区" }));
  await waitFor(() => expect(trustProject).toHaveBeenCalledWith("run-7"));
});
