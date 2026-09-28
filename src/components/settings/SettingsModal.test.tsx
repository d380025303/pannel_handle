// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { APP_THEMES } from "../../themes";
import { SettingsModal } from "./SettingsModal";

vi.mock("./MobileAccessSettings", () => ({
  MobileAccessSettings: () => null
}));

function renderSettingsModal(overrides: Partial<ComponentProps<typeof SettingsModal>> = {}) {
  const onToggleAutoWorkBuddyCheckin = vi.fn();
  return render(
    <I18nProvider locale="zh-CN">
      <SettingsModal
        defaultWindowsShell="cmd"
        onDefaultWindowsShellChange={vi.fn().mockResolvedValue(undefined)}
        autoRestore
        autoWorkBuddyCheckin
        debugMode={false}
        screenshotEnabled
        screenshotShortcut="Ctrl+Shift+S"
        titleBarActionOrder={["terminal", "stats", "skills", "mcp", "assistant", "screenshot", "library", "quickAgent", "create"]}
        titleBarHiddenActions={[]}
        onTitleBarActionsChange={vi.fn().mockResolvedValue(undefined)}
        themeId="dark-slate"
        locale="zh-CN"
        themes={APP_THEMES}
        onToggleAutoRestore={vi.fn()}
        onToggleAutoWorkBuddyCheckin={onToggleAutoWorkBuddyCheckin}
        onToggleDebugMode={vi.fn()}
        onScreenshotEnabledChange={vi.fn().mockResolvedValue(undefined)}
        onScreenshotShortcutChange={vi.fn().mockResolvedValue(undefined)}
        onThemeChange={vi.fn()}
        onLocaleChange={vi.fn()}
        terminalBackgroundImage=""
        terminalBackgroundOpacity={40}
        terminalBackgroundBlur={0}
        terminalBackgroundPositionX={50}
        terminalBackgroundPositionY={50}
        onChooseTerminalBackground={vi.fn().mockResolvedValue(undefined)}
        onClearTerminalBackground={vi.fn().mockResolvedValue(undefined)}
        onTerminalBackgroundOpacityChange={vi.fn()}
        onTerminalBackgroundBlurChange={vi.fn()}
        onTerminalBackgroundPositionPreview={vi.fn()}
        onTerminalBackgroundPositionCommit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
        {...overrides}
      />
    </I18nProvider>
  );
}

describe("SettingsModal navigation", () => {
  beforeEach(() => {
    Object.defineProperty(window, "dingTalkApi", {
      configurable: true,
      value: {
        getConfig: vi.fn().mockResolvedValue({ enabled: false, hasWebhook: false, hasSecret: false }),
        setConfig: vi.fn(),
        clearCredentials: vi.fn(),
        test: vi.fn()
      }
    });
  });

  afterEach(cleanup);

  it("opens general settings by default", () => {
    renderSettingsModal();

    expect(screen.getByRole("tab", { name: "常用配置" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("启动时自动恢复")).toBeTruthy();
  });

  it("toggles CodeBuddy automatic check-in", () => {
    const onToggleAutoWorkBuddyCheckin = vi.fn();
    renderSettingsModal({ onToggleAutoWorkBuddyCheckin });

    const toggle = screen.getByRole("checkbox", { name: "CodeBuddy 自动签到" });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    expect(onToggleAutoWorkBuddyCheckin).toHaveBeenCalledTimes(1);
  });

  it("switches categories and keeps aria-selected in sync", () => {
    renderSettingsModal();
    const generalTab = screen.getByRole("tab", { name: "常用配置" });
    const modelsTab = screen.getByRole("tab", { name: "模型服务" });
    fireEvent.click(modelsTab);
    expect(generalTab.getAttribute("aria-selected")).toBe("false");
    expect(modelsTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "模型服务" })).toBeTruthy();
  });

  it("toggles screenshots and records a valid shortcut", async () => {
    const onScreenshotEnabledChange = vi.fn().mockResolvedValue(undefined);
    const onScreenshotShortcutChange = vi.fn().mockResolvedValue(undefined);
    renderSettingsModal({ onScreenshotEnabledChange, onScreenshotShortcutChange });

    fireEvent.click(screen.getByRole("checkbox", { name: "启用截图功能" }));
    await waitFor(() => expect(onScreenshotEnabledChange).toHaveBeenCalledWith(false));

    const recorder = screen.getByRole("button", { name: "截图快捷键" });
    fireEvent.click(recorder);
    fireEvent.keyDown(recorder, { key: "7", altKey: true, shiftKey: true });
    await waitFor(() => expect(onScreenshotShortcutChange).toHaveBeenCalledWith("Alt+Shift+7"));
  });

  it("keeps recording after a reserved shortcut and cancels with Escape", () => {
    renderSettingsModal();
    const recorder = screen.getByRole("button", { name: "截图快捷键" });
    fireEvent.click(recorder);
    fireEvent.keyDown(recorder, { key: "f", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("alert").textContent).toContain("已被应用占用");
    expect(recorder.textContent).toContain("请按新的组合键");
    fireEvent.keyDown(recorder, { key: "Escape" });
    expect(recorder.textContent).toBe("Ctrl+Shift+S");
  });

  it("shows terminal background settings and wires the actions", async () => {
    const onChooseTerminalBackground = vi.fn().mockResolvedValue(undefined);
    const onClearTerminalBackground = vi.fn().mockResolvedValue(undefined);
    const onTerminalBackgroundOpacityChange = vi.fn();
    renderSettingsModal({
      terminalBackgroundImage: "123-bg.png",
      terminalBackgroundOpacity: 65,
      terminalBackgroundBlur: 12,
      onChooseTerminalBackground,
      onClearTerminalBackground,
      onTerminalBackgroundOpacityChange
    });

    expect(screen.getByText("终端背景")).toBeTruthy();
    const preview = screen.getByRole("img", { name: "终端背景" }) as HTMLImageElement;
    expect(preview.src).toContain("terminal-bg://background/123-bg.png");
    expect(preview.style.opacity).toBe("0.65");
    expect(preview.style.filter).toBe("blur(12px)");

    fireEvent.click(screen.getByRole("button", { name: "选择图片" }));
    await waitFor(() => expect(onChooseTerminalBackground).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    await waitFor(() => expect(onClearTerminalBackground).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole("slider", { name: /不透明度/ }), { target: { value: "80" } });
    expect(onTerminalBackgroundOpacityChange).toHaveBeenCalledWith(80);
  });

  it("disables background controls when no image is set", () => {
    renderSettingsModal();
    expect(screen.getByText("未设置背景图片")).toBeTruthy();
    expect((screen.getByRole("button", { name: "清除" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("slider", { name: /不透明度/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("slider", { name: /模糊/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "恢复居中" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("uses the terminal area's aspect ratio and scales blur in the preview", () => {
    renderSettingsModal({ terminalBackgroundImage: "123-bg.png", terminalBackgroundBlur: 12, terminalBackgroundAreaSize: { width: 800, height: 600 } });
    const preview = screen.getByRole("img", { name: "终端背景" }) as HTMLImageElement;
    const frame = preview.parentElement as HTMLDivElement;
    expect(frame.style.aspectRatio).toBe("800 / 600");
    expect(preview.style.filter).toBe("blur(4.8px)");
    expect(preview.style.inset).toBe("-4.8px");
  });

  it("previews a dragged background position and saves it on release", async () => {
    const onTerminalBackgroundPositionPreview = vi.fn();
    const onTerminalBackgroundPositionCommit = vi.fn().mockResolvedValue(undefined);
    renderSettingsModal({
      terminalBackgroundImage: "123-bg.png",
      onTerminalBackgroundPositionPreview,
      onTerminalBackgroundPositionCommit
    });
    const preview = screen.getByRole("img", { name: "终端背景" }) as HTMLImageElement;
    Object.defineProperties(preview, { naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
    vi.spyOn(preview.parentElement!, "getBoundingClientRect").mockReturnValue({ width: 240, height: 135 } as DOMRect);
    fireEvent.pointerDown(preview, { pointerId: 1, button: 0, clientX: 120, clientY: 60 });
    fireEvent.pointerMove(preview, { pointerId: 1, clientX: 123, clientY: 33 });
    expect(onTerminalBackgroundPositionPreview).toHaveBeenCalledWith(40, 50);
    expect(onTerminalBackgroundPositionCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(preview, { pointerId: 1 });
    await waitFor(() => expect(onTerminalBackgroundPositionCommit).toHaveBeenCalledWith(40, 50));
  });

  it("moves only along the cropped axis for a square background", () => {
    const onTerminalBackgroundPositionPreview = vi.fn();
    renderSettingsModal({ terminalBackgroundImage: "123-bg.png", onTerminalBackgroundPositionPreview });
    const preview = screen.getByRole("img", { name: "终端背景" }) as HTMLImageElement;
    Object.defineProperties(preview, { naturalWidth: { value: 400 }, naturalHeight: { value: 400 } });
    vi.spyOn(preview.parentElement!, "getBoundingClientRect").mockReturnValue({ width: 240, height: 135 } as DOMRect);
    fireEvent.pointerDown(preview, { pointerId: 1, button: 0, clientX: 120, clientY: 60 });
    fireEvent.pointerMove(preview, { pointerId: 1, clientX: 144, clientY: 39 });
    expect(onTerminalBackgroundPositionPreview).toHaveBeenCalledWith(50, 70);
  });

  it("shows a retryable error when centering cannot be saved", async () => {
    const onTerminalBackgroundPositionCommit = vi.fn().mockRejectedValue(new Error("disk unavailable"));
    renderSettingsModal({ terminalBackgroundImage: "123-bg.png", onTerminalBackgroundPositionCommit });
    fireEvent.click(screen.getByRole("button", { name: "恢复居中" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "保存背景位置失败: disk unavailable");
    await waitFor(() => expect((screen.getByRole("button", { name: "恢复居中" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("supports arrow-key category navigation", () => {
    renderSettingsModal();
    const generalTab = screen.getByRole("tab", { name: "常用配置" });
    fireEvent.keyDown(generalTab, { key: "ArrowDown" });
    expect(screen.getByRole("tab", { name: "环境变量" }).getAttribute("aria-selected")).toBe("true");
  });

  it("restores the default category after the modal is remounted", () => {
    const firstView = renderSettingsModal();
    fireEvent.click(screen.getByRole("tab", { name: "模型服务" }));
    firstView.unmount();

    renderSettingsModal();
    expect(screen.getByRole("tab", { name: "常用配置" }).getAttribute("aria-selected")).toBe("true");
  });

  it("protects an unsaved environment draft when changing categories", async () => {
    window.environmentApi = { list: vi.fn(async () => []), save: vi.fn(), delete: vi.fn(), preview: vi.fn() };
    renderSettingsModal();
    fireEvent.click(screen.getByRole("tab", { name: "环境变量" }));
    fireEvent.change(screen.getByLabelText("配置组名称"), { target: { value: "开发代理" } });
    fireEvent.click(screen.getByRole("tab", { name: "模型服务" }));
    expect(await screen.findByRole("alertdialog", { name: "保存环境变量更改？" })).toBeTruthy();
    fireEvent.click(screen.getByText("继续编辑"));
    expect(screen.getByRole("tab", { name: "环境变量" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: "模型服务" }));
    fireEvent.click(screen.getByText("放弃更改"));
    expect(screen.getByRole("tab", { name: "模型服务" }).getAttribute("aria-selected")).toBe("true");
  });

  it("protects an unsaved draft when selecting another profile", async () => {
    window.environmentApi = {
      list: vi.fn(async () => [
        { id: "dev", name: "开发", entries: [], references: [] },
        { id: "prod", name: "生产", entries: [], references: [] }
      ]),
      save: vi.fn(), delete: vi.fn(), preview: vi.fn()
    };
    renderSettingsModal();
    fireEvent.click(screen.getByRole("tab", { name: "环境变量" }));
    await screen.findByRole("option", { name: "开发" });
    fireEvent.change(screen.getByRole("combobox", { name: "配置组" }), { target: { value: "dev" } });
    fireEvent.change(screen.getByLabelText("配置组名称"), { target: { value: "开发修改" } });
    fireEvent.change(screen.getByRole("combobox", { name: "配置组" }), { target: { value: "prod" } });
    expect(await screen.findByRole("alertdialog", { name: "保存环境变量更改？" })).toBeTruthy();
    fireEvent.click(screen.getByText("放弃更改"));
    expect((screen.getByLabelText("配置组名称") as HTMLInputElement).value).toBe("生产");
  });

  it("saves an environment draft before closing", async () => {
    const onCancel = vi.fn();
    const save = vi.fn(async input => [{ ...input, id: "dev", references: [] }]);
    window.environmentApi = { list: vi.fn(async () => []), save, delete: vi.fn(), preview: vi.fn() };
    renderSettingsModal({ onCancel });
    fireEvent.click(screen.getByRole("tab", { name: "环境变量" }));
    fireEvent.change(screen.getByLabelText("配置组名称"), { target: { value: "开发" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(await screen.findByText("保存并继续"));
    await screen.findByText("已保存，下次启动会话生效。");
    expect(save).toHaveBeenCalledWith({ id: undefined, name: "开发", entries: [] });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft open when save-before-close fails", async () => {
    const onCancel = vi.fn();
    window.environmentApi = { list: vi.fn(async () => []), save: vi.fn(async () => { throw new Error("保存失败"); }), delete: vi.fn(), preview: vi.fn() };
    renderSettingsModal({ onCancel });
    fireEvent.click(screen.getByRole("tab", { name: "环境变量" }));
    fireEvent.change(screen.getByLabelText("配置组名称"), { target: { value: "开发" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(await screen.findByText("保存并继续"));
    expect(await screen.findByText("保存失败")).toBeTruthy();
    expect(screen.queryByRole("alertdialog", { name: "保存环境变量更改？" })).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
