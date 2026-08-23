// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalSession } from "../../vite-env";
import { AgentSwitcher } from "./AgentSwitcher";

function session(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: "run-1",
    title: "Codex",
    shell: "powershell.exe",
    cwd: "C:\\work",
    createdAt: 1,
    type: "windows",
    agentProvider: "codex",
    ...overrides
  };
}

afterEach(cleanup);

describe("AgentSwitcher", () => {
  it("switches the active session without offering the current provider", async () => {
    const onSwitch = vi.fn(async () => {});
    render(<AgentSwitcher session={session()} onSwitch={onSwitch} />);

    fireEvent.click(screen.getByRole("button", { name: "切换当前会话的 Agent" }));
    expect(screen.queryByRole("menuitem", { name: "Codex" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Claude" }));

    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith("run-1", "claude"));
  });

  it("hides for normal terminals and disables local SSH bridge sessions", () => {
    const onSwitch = vi.fn(async () => {});
    const { rerender } = render(<AgentSwitcher session={session({ agentProvider: undefined })} onSwitch={onSwitch} />);
    expect(screen.queryByRole("button")).toBeNull();

    rerender(<AgentSwitcher session={session({ type: "ssh", agentLocation: "local" })} onSwitch={onSwitch} />);
    const trigger = screen.getByRole("button", { name: "本机 SSH 桥接仅支持 Codex，无法切换 Agent" });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a dismissible error when switching fails", async () => {
    const onSwitch = vi.fn(async () => { throw new Error("Failed to start replacement terminal."); });
    render(<AgentSwitcher session={session()} onSwitch={onSwitch} />);

    fireEvent.click(screen.getByRole("button", { name: "切换当前会话的 Agent" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Claude" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Failed to start replacement terminal.");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers Qwen Code for local sessions but not SSH sessions", () => {
    const onSwitch = vi.fn(async () => {});
    const { rerender } = render(<AgentSwitcher session={session()} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: /Agent/ }));
    expect(screen.getByRole("menuitem", { name: "Qwen Code" })).toBeTruthy();
    rerender(<AgentSwitcher session={session({ type: "ssh", agentLocation: "remote" })} onSwitch={onSwitch} />);
    expect(screen.queryByRole("menuitem", { name: "Qwen Code" })).toBeNull();
  });

  it("offers GitHub Copilot locally but not over SSH", () => {
    const onSwitch = vi.fn(async () => {});
    const { rerender } = render(<AgentSwitcher session={session()} onSwitch={onSwitch} />);

    fireEvent.click(screen.getByRole("button", { name: /Agent/ }));
    expect(screen.getByRole("menuitem", { name: "GitHub Copilot" })).toBeTruthy();

    rerender(<AgentSwitcher session={session({ type: "ssh", agentLocation: "remote" })} onSwitch={onSwitch} />);
    expect(screen.queryByRole("menuitem", { name: "GitHub Copilot" })).toBeNull();
  });
});
