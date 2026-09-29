// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { CodexQuotaSettings } from "./CodexQuotaSettings";

describe("CodexQuotaSettings", () => {
  afterEach(cleanup);

  it("loads local quota, refreshes it, and cancels on unmount", async () => {
    const getCodexUsage = vi.fn().mockResolvedValue({
      provider: "codex", fetchedAt: Date.now(), primaryLimitId: "codex", limits: [
        { id: "codex", name: "Codex", usedPercent: 30, remainingPercent: 70 }
      ], resetCredits: { availableCount: 1 }
    });
    const cancelCodexUsage = vi.fn();
    Object.defineProperty(window, "agentUsageApi", { configurable: true, value: { getCodexUsage, cancelCodexUsage } });
    const view = render(<I18nProvider locale="zh-CN"><CodexQuotaSettings /></I18nProvider>);

    expect(await screen.findByRole("progressbar", { name: "Codex" })).toBeTruthy();
    expect(screen.getByText("1 个可用")).toBeTruthy();
    expect(getCodexUsage).toHaveBeenCalledWith({ force: false });
    const toggle = screen.getByRole("button", { name: "Codex 额度" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("progressbar", { name: "Codex" })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("progressbar", { name: "Codex" })).toBeTruthy();
    expect(getCodexUsage).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "刷新 Codex 额度" }));
    await waitFor(() => expect(getCodexUsage).toHaveBeenCalledWith({ force: true }));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    view.unmount();
    expect(cancelCodexUsage).toHaveBeenCalledTimes(1);
  });
});
