// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
        themeId="dark-slate"
        locale="zh-CN"
        themes={APP_THEMES}
        onToggleAutoRestore={vi.fn()}
        onToggleAutoWorkBuddyCheckin={onToggleAutoWorkBuddyCheckin}
        onToggleDebugMode={vi.fn()}
        onThemeChange={vi.fn()}
        onLocaleChange={vi.fn()}
        onCancel={vi.fn()}
        {...overrides}
      />
    </I18nProvider>
  );
}

describe("SettingsModal collapsible sections", () => {
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

    expect(screen.getByRole("button", { name: "常用配置" }).getAttribute("aria-expanded")).toBe("true");
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

  it("supports click and Enter while keeping aria-expanded in sync", () => {
    renderSettingsModal();
    const generalHeader = screen.getByRole("button", { name: "常用配置" });

    fireEvent.click(generalHeader);
    expect(generalHeader.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(generalHeader, { key: "Enter" });
    expect(generalHeader.getAttribute("aria-expanded")).toBe("true");

  });

  it("restores the default expansion state after the modal is remounted", () => {
    const firstView = renderSettingsModal();
    fireEvent.click(screen.getByRole("button", { name: "常用配置" }));
    firstView.unmount();

    renderSettingsModal();
    expect(screen.getByRole("button", { name: "常用配置" }).getAttribute("aria-expanded")).toBe("true");
  });
});
