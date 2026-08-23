// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { QuickCommand, TerminalApi } from "../../vite-env";
import { QuickCommandBar } from "./QuickCommandBar";

const commands: QuickCommand[] = [
  { id: "first", command: "first command", mode: "write" },
  { id: "pinned", command: "pinned command", mode: "auto-enter", pinned: true },
  { id: "third", command: "third command", mode: "one-time" },
  { id: "fourth", command: "fourth command", mode: "write" }
];

const focusTerminal = vi.fn();
const addQuickCommand = vi.fn();
const removeQuickCommand = vi.fn();
const togglePinned = vi.fn();

function renderBar(quickCommands = commands) {
  return render(
    <I18nProvider locale="zh-CN">
      <QuickCommandBar
        quickCommands={quickCommands}
        activeSessionId="session-1"
        onFocusTerminal={focusTerminal}
        onAddQuickCommand={addQuickCommand}
        onRemoveQuickCommand={removeQuickCommand}
        onTogglePinned={togglePinned}
      />
    </I18nProvider>
  );
}

describe("QuickCommandBar", () => {
  const write = vi.fn();

  beforeEach(() => {
    window.terminalApi = { write } as unknown as TerminalApi;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows pinned commands first and fills the three direct slots in configured order", () => {
    const { container } = renderBar();
    const directButtons = Array.from(container.querySelectorAll(".quick-command-direct"));
    const labels = directButtons.map((element) => element.querySelector(".quick-command-label")?.textContent);
    expect(labels).toEqual(["pinned command", "first command", "third command"]);
    expect(directButtons.map((element) => element.classList.contains("pinned"))).toEqual([true, false, false]);
    expect(screen.getByRole("button", { name: /更多/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("marks all three pinned direct commands so responsive styles keep them visible", () => {
    const { container } = renderBar(commands.slice(0, 3).map((command) => ({ ...command, pinned: true })));
    const directButtons = Array.from(container.querySelectorAll(".quick-command-direct"));

    expect(directButtons).toHaveLength(3);
    expect(directButtons.every((element) => element.classList.contains("pinned"))).toBe(true);
  });

  it("keeps execution modes and one-time removal behavior", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "pinned command" }));
    expect(write).toHaveBeenCalledWith("session-1", "pinned command\r");
    expect(focusTerminal).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "third command" }));
    expect(write).toHaveBeenCalledWith("session-1", "third command");
    expect(removeQuickCommand).toHaveBeenCalledWith("third");
  });

  it("opens all commands and enforces the three-pin limit", () => {
    renderBar([
      { ...commands[0], pinned: true },
      commands[1],
      { ...commands[2], pinned: true },
      commands[3]
    ]);
    fireEvent.click(screen.getByRole("button", { name: /更多/ }));

    expect(screen.getByRole("dialog", { name: "全部快捷命令" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "最多置顶 3 个命令: fourth command" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取消置顶: pinned command" }));
    expect(togglePinned).toHaveBeenCalledWith("pinned");
  });

  it("adds a trimmed one-time command from the popover", () => {
    renderBar([]);
    fireEvent.click(screen.getByRole("button", { name: /快捷命令/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "命令内容" }), { target: { value: "  pnpm build  " } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "命令内容" }), { key: "Enter" });
    expect(addQuickCommand).toHaveBeenCalledWith("pnpm build", "one-time");
  });

  it("closes on Escape and restores focus to the trigger", () => {
    vi.useFakeTimers();
    renderBar();
    const trigger = screen.getByRole("button", { name: /更多/ });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    vi.runAllTimers();
    expect(screen.queryByRole("dialog", { name: "全部快捷命令" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    vi.useRealTimers();
  });
});
