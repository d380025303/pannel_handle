// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TerminalSession } from "../../vite-env";
import { SessionModeSwitch } from "./SessionModeSwitch";

const session: TerminalSession = { id: "run-1", title: "Codex", shell: "powershell.exe", cwd: "C:\\work",
  createdAt: 1, type: "windows", agentProvider: "codex", runtimeMode: "terminal" };

afterEach(cleanup);

it("offers the opposite mode and keeps a failed launch retryable", async () => {
  const onOpenOtherMode = vi.fn().mockRejectedValueOnce(new Error("启动失败")).mockResolvedValue(undefined);
  const { rerender } = render(<SessionModeSwitch session={session} onOpenOtherMode={onOpenOtherMode} />);
  fireEvent.click(screen.getByRole("button", { name: "以图形对话打开" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "启动失败");
  fireEvent.click(screen.getByRole("button", { name: "以图形对话打开" }));
  await waitFor(() => expect(onOpenOtherMode).toHaveBeenCalledTimes(2));
  rerender(<SessionModeSwitch session={{ ...session, runtimeMode: "app-server" }} onOpenOtherMode={onOpenOtherMode} />);
  expect(screen.getByRole("button", { name: "以终端打开" })).toBeTruthy();
});

it("hides modes that the current provider and environment cannot open", () => {
  const { rerender } = render(<SessionModeSwitch session={{ ...session, agentProvider: undefined }} onOpenOtherMode={vi.fn()} />);
  expect(screen.queryByRole("button")).toBeNull();
  rerender(<SessionModeSwitch session={{ ...session, type: "ssh", agentProvider: "claude", agentLocation: "local",
    runtimeMode: "app-server" }} onOpenOtherMode={vi.fn()} />);
  expect(screen.queryByRole("button")).toBeNull();
});
