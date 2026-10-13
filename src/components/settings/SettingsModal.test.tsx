// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
        desktopMascotEnabled
        onDesktopMascotEnabledChange={vi.fn().mockResolvedValue(undefined)}
        screenshotEnabled
        screenshotShortcut="Ctrl+Shift+S"
        titleBarActionOrder={["terminal", "stats", "skills", "mcp", "screenshot", "library", "quickAgent", "create"]}
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
  it("keeps forward and backward keyboard navigation inside settings and restores the opener", async () => {
    const user = userEvent.setup();
    const opener = document.createElement("button");
    opener.textContent = "打开设置";
    const backgroundAction = vi.fn();
    opener.onclick = backgroundAction;
    document.body.append(opener);
    opener.focus();
    const view = renderSettingsModal();
    const close = screen.getByRole("button", { name: "关闭" });
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(close);
    for (let index = 0; index < 50; index++) {
      await user.tab({ shift: index >= 25 });
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement?.closest('[hidden]')).toBeNull();
    }
    await user.keyboard("{Enter}");
    expect(backgroundAction).not.toHaveBeenCalled();
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  }, 15000);

  it("allows portal search focus and returns Tab navigation to the settings controls", async () => {
    const user = userEvent.setup();
    renderSettingsModal();
    const theme = screen.getByRole("combobox", { name: "主题" });
    await user.click(theme);
    const search = screen.getByRole("combobox", { name: "搜索选项..." });
    expect(document.activeElement).toBe(search);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "语言" }));
    await user.click(theme);
    await user.tab({ shift: true });
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(theme);
  });
  it("opens the companion category and saves its toggle", async () => {
    let finish!: () => void;
    const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    renderSettingsModal({ onDesktopMascotEnabledChange: save });
    fireEvent.click(screen.getByRole("tab", { name: "看板娘" }));
    const toggle = screen.getByRole("checkbox", { name: "开启看板娘" });
    expect(toggle).toHaveProperty("checked", true);
    fireEvent.click(toggle);
    expect(save).toHaveBeenCalledWith(false);
    expect(toggle).toHaveProperty("disabled", true);
    finish();
    await waitFor(() => expect(toggle).toHaveProperty("disabled", false));
  });

  it("keeps companion state and displays save failures", async () => {
    const save = vi.fn().mockRejectedValue(new Error("save failed"));
    renderSettingsModal({ desktopMascotEnabled: false, onDesktopMascotEnabledChange: save });
    fireEvent.click(screen.getByRole("tab", { name: "看板娘" }));
    const toggle = screen.getByRole("checkbox", { name: "开启看板娘" });
    fireEvent.click(toggle);
    expect(save).toHaveBeenCalledWith(true);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "save failed");
    expect(toggle).toHaveProperty("checked", false);
  });

  it("saves the graphical minimal mode toggle and shows save failures", async () => {
    const save = vi.fn().mockRejectedValue(new Error("save failed"));
    renderSettingsModal({ onGraphicalSessionMinimalModeChange: save });
    const toggle = screen.getByRole("checkbox", { name: "图形会话极简模式" });
    expect(toggle).toHaveProperty("checked", false);
    fireEvent.click(toggle);
    await waitFor(() => expect(save).toHaveBeenCalledWith(true));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "save failed");
    expect(toggle).toHaveProperty("checked", false);
  });

  beforeEach(() => {
    Object.defineProperty(window, "terminalApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ graphicalMenuSecondaryActions: {} }),
      onGraphicalMenuConfigChanged: () => () => {}
    } });
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
    expect(screen.queryByText("更多菜单隐藏配置")).toBeNull();
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

  it("opens a separate quota page and shows the three provider sections", async () => {
    Object.defineProperty(window, "agentUsageApi", { configurable: true, value: {
      getCodexUsage: vi.fn().mockRejectedValue(new Error("Codex unavailable")),
      getCodeBuddyUsage: vi.fn().mockRejectedValue(new Error("CodeBuddy unavailable")),
      cancelCodexUsage: vi.fn(), cancelCodeBuddyUsage: vi.fn()
    } });
    Object.defineProperty(window, "miniMaxApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ hasApiKey: false }),
      listModels: vi.fn().mockResolvedValue([])
    } });
    renderSettingsModal();
    fireEvent.click(screen.getByRole("tab", { name: "额度" }));
    expect(screen.getByRole("tabpanel", { name: "额度" })).toBeTruthy();
    const quotaPage = screen.getByRole("tabpanel", { name: "额度" });
    for (const name of ["Codex 额度", "CodeBuddy 额度", "MiniMAX 额度"]) {
      const card = screen.getByRole("region", { name });
      expect(card.parentElement).toBe(quotaPage);
      expect(card.classList.contains("codebuddy-quota-settings")).toBe(true);
    }
    const codexToggle = screen.getByRole("button", { name: "Codex 额度" });
    const codeBuddyToggle = screen.getByRole("button", { name: "CodeBuddy 额度" });
    const miniMaxToggle = screen.getByRole("button", { name: "MiniMAX 额度" });
    expect([codexToggle, codeBuddyToggle, miniMaxToggle].map(button => button.getAttribute("aria-expanded"))).toEqual(["true", "true", "true"]);
    fireEvent.click(codeBuddyToggle);
    expect([codexToggle, codeBuddyToggle, miniMaxToggle].map(button => button.getAttribute("aria-expanded"))).toEqual(["true", "false", "true"]);
    expect(await screen.findByText("请先在“模型服务”中配置 MiniMAX API Key。")).toBeTruthy();
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
    expect(screen.getByRole("tab", { name: "看板娘" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "看板娘" }), { key: "ArrowDown" });
    expect(screen.getByRole("tab", { name: "环境变量" }).getAttribute("aria-selected")).toBe("true");
  });

  it("restores the default category after the modal is remounted", () => {
    const firstView = renderSettingsModal();
    fireEvent.click(screen.getByRole("tab", { name: "模型服务" }));
    firstView.unmount();

    renderSettingsModal();
    expect(screen.getByRole("tab", { name: "常用配置" }).getAttribute("aria-selected")).toBe("true");
  });

  it("protects an unsaved environment draft when opening the tool catalog", async () => {
    window.environmentApi = { list: vi.fn(async () => []), save: vi.fn(), delete: vi.fn(), preview: vi.fn() };
    renderSettingsModal();
    fireEvent.click(screen.getByRole("tab", { name: "环境变量" }));
    fireEvent.change(screen.getByLabelText("配置组名称"), { target: { value: "开发代理" } });
    fireEvent.click(screen.getByRole("tab", { name: "项目工具" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "保存环境变量更改？" });
    expect(confirmation.contains(document.activeElement)).toBe(true);
    const user = userEvent.setup();
    for (let index = 0; index < 8; index++) {
      await user.tab({ shift: index >= 4 });
      expect(confirmation.contains(document.activeElement)).toBe(true);
    }
    fireEvent.click(screen.getByText("继续编辑"));
    expect(screen.getByRole("tab", { name: "环境变量" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: "项目工具" }));
    fireEvent.click(screen.getByText("放弃更改"));
    expect(screen.getByRole("tab", { name: "项目工具" }).getAttribute("aria-selected")).toBe("true");
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

  it("protects bulk input on close, preserves it while editing and clears it on discard", async () => {
    const onCancel = vi.fn();
    window.environmentApi = { list: vi.fn(async () => []), save: vi.fn(), delete: vi.fn(), preview: vi.fn() };
    renderSettingsModal({ onCancel });
    fireEvent.click(screen.getByRole("tab", { name: "环境变量" }));
    fireEvent.click(screen.getByText("批量粘贴 KEY=VALUE"));
    const input = screen.getByLabelText("批量环境变量") as HTMLTextAreaElement;
    const text = "TEST_FLAG=true\nSECOND=value=with=equals";
    fireEvent.change(input, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(await screen.findByText("继续编辑"));
    expect(input.value).toBe(text);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(await screen.findByText("放弃更改"));
    expect(input.value).toBe("");
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("keeps invalid bulk input open and saves corrected input before closing", async () => {
    const onCancel = vi.fn();
    const save = vi.fn(async input => [{ ...input, id: "dev", references: [] }]);
    window.environmentApi = { list: vi.fn(async () => [{ id: "dev", name: "开发", entries: [{ name: "EXISTING", value: "1" }], references: [] }]), save, delete: vi.fn(), preview: vi.fn() };
    renderSettingsModal({ onCancel });
    fireEvent.click(screen.getByRole("tab", { name: "环境变量" }));
    await screen.findByRole("option", { name: "开发" });
    fireEvent.change(screen.getByRole("combobox", { name: "配置组" }), { target: { value: "dev" } });
    fireEvent.click(screen.getByText("批量粘贴 KEY=VALUE"));
    const input = screen.getByLabelText("批量环境变量") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "TEST_FLAG=true\nINVALID" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(await screen.findByText("保存并继续"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(save).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(input.value).toBe("TEST_FLAG=true\nINVALID");
    fireEvent.change(input, { target: { value: "TEST_FLAG=true" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(await screen.findByText("保存并继续"));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ id: "dev", name: "开发", entries: [{ name: "EXISTING", value: "1" }, { name: "TEST_FLAG", value: "true" }] });
    expect(input.value).toBe("");
    expect((screen.getByLabelText("变量名 2") as HTMLInputElement).value).toBe("TEST_FLAG");
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
    fireEvent.click(screen.getByText("批量粘贴 KEY=VALUE"));
    fireEvent.change(screen.getByLabelText("批量环境变量"), { target: { value: "TEST_FLAG=true" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(await screen.findByText("保存并继续"));
    expect(await screen.findByText("保存失败")).toBeTruthy();
    expect(screen.queryByRole("alertdialog", { name: "保存环境变量更改？" })).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    expect((screen.getByLabelText("批量环境变量") as HTMLTextAreaElement).value).toBe("TEST_FLAG=true");
  });

  it("opens the project tool catalog and closes details without closing settings", async () => {
    const onCancel = vi.fn();
    window.projectToolsApi = { list: vi.fn().mockResolvedValue([{ name: "list_module_owners", group: "owners", description: "List owners", summary: { "zh-CN": "查询负责人", "en-US": "List owners" }, readOnly: true, inputSchema: {}, example: {}, conditions: { "zh-CN": "需要授权" }, result: { "zh-CN": "返回负责人" }, resultExample: [] }]) };
    renderSettingsModal({ onCancel });
    fireEvent.click(screen.getByRole("tab", { name: "项目工具" }));
    fireEvent.click(await screen.findByRole("button", { name: "详情 list_module_owners" }));
    const detail = screen.getByRole("dialog", { name: "list_module_owners" });
    const user = userEvent.setup();
    for (let index = 0; index < 6; index++) {
      await user.tab({ shift: index >= 3 });
      expect(detail.contains(document.activeElement)).toBe(true);
    }
    fireEvent.keyDown(screen.getByRole("dialog", { name: "list_module_owners" }), { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "项目工具" }).getAttribute("aria-selected")).toBe("true");
  });

});

it("places the independent mobile minimal toggle after the desktop toggle and reports save failures", async () => {
  let rejectSave!: (error: Error) => void;
  const save = vi.fn(() => new Promise<void>((_, reject) => { rejectSave = reject; }));
  const desktopSave = vi.fn();
  renderSettingsModal({ graphicalSessionMinimalMode: true, mobileGraphicalSessionMinimalMode: false, onGraphicalSessionMinimalModeChange: desktopSave, onMobileGraphicalSessionMinimalModeChange: save });
  const desktop = screen.getByRole("checkbox", { name: "图形会话极简模式" }) as HTMLInputElement;
  const mobile = screen.getByRole("checkbox", { name: "移动端图形会话极简模式" }) as HTMLInputElement;
  expect(desktop.checked).toBe(true);
  expect(mobile.checked).toBe(false);
  expect(desktop.compareDocumentPosition(mobile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(mobile);
  expect(save).toHaveBeenCalledWith(true);
  expect(mobile.disabled).toBe(true);
  expect(desktopSave).not.toHaveBeenCalled();
  rejectSave(new Error("保存失败"));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("保存失败"));
  expect(mobile.disabled).toBe(false);
  expect(mobile.checked).toBe(false);
});
