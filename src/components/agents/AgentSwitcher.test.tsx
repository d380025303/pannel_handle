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

    fireEvent.click(screen.getByRole("button", { name: /切换当前会话的 Agent/ }));
    expect(screen.getByRole("button", { name: /当前 Codex/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Codex" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Claude" }));

    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith("run-1", "claude"));
  });

  it("hides for normal terminals and limits local SSH bridge switching to supported providers", () => {
    const onSwitch = vi.fn(async () => {});
    const { rerender } = render(<AgentSwitcher session={session({ agentProvider: undefined })} onSwitch={onSwitch} />);
    expect(screen.queryByRole("button")).toBeNull();

    rerender(<AgentSwitcher session={session({ type: "ssh", agentLocation: "local" })} onSwitch={onSwitch} />);
    const trigger = screen.getByRole("button", { name: /切换当前会话的 Agent/ });
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "OpenCode" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "CodeBuddy" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Claude" })).toBeNull();
  });

  it("switches a local OpenCode bridge back to Codex", async () => {
    const onSwitch = vi.fn(async () => {});
    render(<AgentSwitcher session={session({ type: "ssh", agentProvider: "opencode", agentLocation: "local" })} onSwitch={onSwitch} />);

    fireEvent.click(screen.getByRole("button", { name: /切换当前会话的 Agent/ }));
    expect(screen.getByRole("button", { name: /当前 OpenCode/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Codex" }));

    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith("run-1", "codex"));
  });

  it("offers Claude for a graphical local SSH bridge", () => {
    render(<AgentSwitcher session={session({ type: "ssh", agentLocation: "local", runtimeMode: "app-server" })} onSwitch={vi.fn(async () => {})} />);

    fireEvent.click(screen.getByRole("button", { name: /切换当前会话的 Agent/ }));
    expect(screen.getByRole("menuitem", { name: "Claude" })).toBeTruthy();
  });

  it("shows a dismissible error when switching fails", async () => {
    const onSwitch = vi.fn(async () => { throw new Error("Failed to start replacement terminal."); });
    render(<AgentSwitcher session={session()} onSwitch={onSwitch} />);

    fireEvent.click(screen.getByRole("button", { name: /切换当前会话的 Agent/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Claude" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Failed to start replacement terminal.");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers GitHub Copilot locally but not over SSH", () => {
    const onSwitch = vi.fn(async () => {});
    const { rerender } = render(<AgentSwitcher session={session()} onSwitch={onSwitch} />);

    fireEvent.click(screen.getByRole("button", { name: /切换当前会话的 Agent/ }));
    expect(screen.getByRole("menuitem", { name: "GitHub Copilot" })).toBeTruthy();

    rerender(<AgentSwitcher session={session({ type: "ssh", agentLocation: "remote" })} onSwitch={onSwitch} />);
    expect(screen.queryByRole("menuitem", { name: "GitHub Copilot" })).toBeNull();
  });
});
