// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TitleBar } from "./TitleBar";

describe("TitleBar session actions", () => {
  afterEach(cleanup);

  it("opens the session library and create dialog from the brand actions", () => {
    const onOpenPicker = vi.fn();
    const onOpenCreate = vi.fn();
    const { container } = render(
      <TitleBar
        activeTitle="PowerShell"
        isMaximized={false}
        mobileAccessState={null}
        onOpenSettings={() => undefined}
        onOpenPicker={onOpenPicker}
        onOpenCreate={onOpenCreate}
      />
    );

    const actionGroup = container.querySelector(".titlebar-actions");
    const libraryButton = screen.getByRole("button", { name: "从库中启动" });
    const createButton = screen.getByRole("button", { name: "新建会话" });

    expect(actionGroup?.contains(libraryButton)).toBe(true);
    expect(actionGroup?.contains(createButton)).toBe(true);
    expect(libraryButton.compareDocumentPosition(createButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(libraryButton);
    fireEvent.click(createButton);

    expect(onOpenPicker).toHaveBeenCalledTimes(1);
    expect(onOpenCreate).toHaveBeenCalledTimes(1);
  });

  it("quick-creates a selected local Agent from the title bar menu", async () => {
    const onQuickCreateAgent = vi.fn().mockResolvedValue(undefined);
    render(
      <TitleBar
        activeTitle="PowerShell"
        isMaximized={false}
        mobileAccessState={null}
        onOpenSettings={() => undefined}
        onOpenPicker={() => undefined}
        onOpenCreate={() => undefined}
        onQuickCreateAgent={onQuickCreateAgent}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "快速创建本机 Agent 会话" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Claude",
      "Codex",
      "CodeBuddy",
      "OpenCode",
      "Qoder",
      "GitHub Copilot",
      "Gemini CLI",
      "Grok CLI"
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Codex" }));
    await waitFor(() => expect(onQuickCreateAgent).toHaveBeenCalledWith("codex"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the quick Agent menu with Escape", () => {
    render(
      <TitleBar
        activeTitle="PowerShell"
        isMaximized={false}
        mobileAccessState={null}
        onOpenSettings={() => undefined}
        onOpenPicker={() => undefined}
        onOpenCreate={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "快速创建本机 Agent 会话" }));
    expect(screen.getByRole("menu")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows the screenshot action only while the feature is enabled", () => {
    const onCaptureScreenshot = vi.fn();
    const { rerender } = render(
      <TitleBar
        activeTitle="PowerShell"
        isMaximized={false}
        mobileAccessState={null}
        screenshotEnabled
        onCaptureScreenshot={onCaptureScreenshot}
        onOpenSettings={() => undefined}
        onOpenPicker={() => undefined}
        onOpenCreate={() => undefined}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "区域截图" }));
    expect(onCaptureScreenshot).toHaveBeenCalledTimes(1);

    rerender(
      <TitleBar
        activeTitle="PowerShell"
        isMaximized={false}
        mobileAccessState={null}
        screenshotEnabled={false}
        onCaptureScreenshot={onCaptureScreenshot}
        onOpenSettings={() => undefined}
        onOpenPicker={() => undefined}
        onOpenCreate={() => undefined}
      />
    );
    expect(screen.queryByRole("button", { name: "区域截图" })).toBeNull();
  });

  it("uses the configured order and keeps settings available even if hidden was requested", () => {
    const onOpenSettings = vi.fn();
    const { container } = render(<TitleBar isMaximized={false} mobileAccessState={null}
      actionOrder={["settings", "create", "terminal", "stats", "skills", "mcp", "idea", "screenshot", "library", "quickAgent"]}
      hiddenActions={["settings", "terminal", "library"]}
      onOpenSettings={onOpenSettings} onOpenPicker={() => undefined} onOpenCreate={() => undefined} />);
    const buttons = Array.from(container.querySelectorAll(".titlebar-actions > button, .titlebar-quick-agent > button"));
    expect(buttons.map(button => button.getAttribute("aria-label")).slice(0, 4)).toEqual(["打开设置", "新建会话", "打开 Token 统计", "打开 Skills"]);
    expect(screen.queryByRole("button", { name: "打开终端" })).toBeNull();
    expect(screen.queryByRole("button", { name: "从库中启动" })).toBeNull();
    expect(screen.getByRole("button", { name: "打开设置" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "打开 IDEA" })).toBeTruthy();
  });

  it("keeps settings visible when a running main process returns an old action order", () => {
    const onOpenSettings = vi.fn();
    const { container } = render(<TitleBar isMaximized={false} mobileAccessState={null}
      actionOrder={["create", "terminal", "stats", "skills", "mcp", "idea", "screenshot", "library", "quickAgent"]}
      onOpenSettings={onOpenSettings} onOpenPicker={() => undefined} onOpenCreate={() => undefined} />);
    const buttons = Array.from(container.querySelectorAll(".titlebar-actions > button, .titlebar-quick-agent > button"));
    expect(buttons.map(button => button.getAttribute("aria-label")).slice(5, 8)).toEqual(["打开 IDEA", "打开设置", "从库中启动"]);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
