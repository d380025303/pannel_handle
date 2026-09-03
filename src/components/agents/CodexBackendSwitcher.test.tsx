// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalSession } from "../../vite-env";
import { CodexBackendSwitcher } from "./CodexBackendSwitcher";

function session(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: "run-1",
    title: "Codex",
    shell: "powershell.exe",
    cwd: "C:\\work",
    createdAt: 1,
    type: "windows",
    agentProvider: "codex",
    codexBackend: "openai",
    ...overrides
  };
}

afterEach(cleanup);

describe("CodexBackendSwitcher", () => {
  it("switches the active Codex session without offering the current backend", async () => {
    const onSwitch = vi.fn(async () => {});
    render(<CodexBackendSwitcher session={session()} onSwitch={onSwitch} />);

    fireEvent.click(screen.getByRole("button", { name: "切换当前 Codex 会话的模型后端" }));
    expect(screen.queryByRole("menuitem", { name: "OpenAI" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "MiniMax" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "OpenRouter" }));

    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith("run-1", "openrouter"));
  });

  it("hides outside local Windows and WSL Codex sessions", () => {
    const onSwitch = vi.fn(async () => {});
    const { rerender } = render(<CodexBackendSwitcher session={session({ agentProvider: "claude" })} onSwitch={onSwitch} />);
    expect(screen.queryByRole("button")).toBeNull();

    rerender(<CodexBackendSwitcher session={session({ type: "ssh" })} onSwitch={onSwitch} />);
    expect(screen.queryByRole("button")).toBeNull();

    rerender(<CodexBackendSwitcher session={session({ type: "wsl", wslDistro: "Ubuntu" })} onSwitch={onSwitch} />);
    expect(screen.getByRole("button", { name: "切换当前 Codex 会话的模型后端" })).toBeTruthy();
  });

  it("shows a dismissible error when switching fails", async () => {
    const onSwitch = vi.fn(async () => { throw new Error("请先配置默认模型。"); });
    render(<CodexBackendSwitcher session={session()} onSwitch={onSwitch} />);

    fireEvent.click(screen.getByRole("button", { name: "切换当前 Codex 会话的模型后端" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "CodeBuddy" }));
    expect((await screen.findByRole("alert")).textContent).toContain("请先配置默认模型。");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
