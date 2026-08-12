// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { APP_THEMES } from "../../themes";
import { SettingsModal } from "./SettingsModal";

vi.mock("./MobileAccessSettings", () => ({
  MobileAccessSettings: () => null
}));

function renderSettingsModal() {
  return render(
    <I18nProvider locale="zh-CN">
      <SettingsModal
        autoRestore
        debugMode={false}
        themeId="dark-slate"
        locale="zh-CN"
        themes={APP_THEMES}
        agentOutputHistoryMaxEntries={1000}
        agentOutputMaxBytes={1024 * 1024}
        onToggleAutoRestore={vi.fn()}
        onToggleDebugMode={vi.fn()}
        onThemeChange={vi.fn()}
        onLocaleChange={vi.fn()}
        onSaveAgentOutputHistory={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
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

  it("opens general settings and collapses Agent logs by default", () => {
    renderSettingsModal();

    expect(screen.getByRole("button", { name: "常用配置" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("启动时自动恢复")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Agent 输出日志" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("每个 Agent 会话模板保留次数")).toBeNull();
  });

  it("supports click, Enter, and Space while keeping aria-expanded in sync", () => {
    renderSettingsModal();
    const generalHeader = screen.getByRole("button", { name: "常用配置" });
    const agentHeader = screen.getByRole("button", { name: "Agent 输出日志" });

    fireEvent.click(generalHeader);
    expect(generalHeader.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(generalHeader, { key: "Enter" });
    expect(generalHeader.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(agentHeader, { key: " " });
    expect(agentHeader.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("每个 Agent 会话模板保留次数")).toBeTruthy();
  });

  it("keeps unsaved Agent values when the section is collapsed", () => {
    renderSettingsModal();
    const agentHeader = screen.getByRole("button", { name: "Agent 输出日志" });

    fireEvent.click(agentHeader);
    const historyInput = screen.getByLabelText("每个 Agent 会话模板保留次数") as HTMLInputElement;
    fireEvent.change(historyInput, { target: { value: "42" } });

    fireEvent.click(agentHeader);
    expect(screen.queryByLabelText("每个 Agent 会话模板保留次数")).toBeNull();
    fireEvent.click(agentHeader);
    expect((screen.getByLabelText("每个 Agent 会话模板保留次数") as HTMLInputElement).value).toBe("42");
  });

  it("restores the default expansion state after the modal is remounted", () => {
    const firstView = renderSettingsModal();
    fireEvent.click(screen.getByRole("button", { name: "常用配置" }));
    fireEvent.click(screen.getByRole("button", { name: "Agent 输出日志" }));
    firstView.unmount();

    renderSettingsModal();
    expect(screen.getByRole("button", { name: "常用配置" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Agent 输出日志" }).getAttribute("aria-expanded")).toBe("false");
  });
});
