// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { MiniMaxQuotaSettings } from "./MiniMaxQuotaSettings";

describe("MiniMaxQuotaSettings", () => {
  afterEach(cleanup);

  it("shows quota details when a key is configured", async () => {
    const getUsage = vi.fn().mockResolvedValue({
      provider: "minimax", fetchedAt: Date.now(), primaryLimitId: "plan", limits: [
        { id: "plan", name: "MiniMAX plan", usedPercent: 20, remainingPercent: 80 }
      ]
    });
    Object.defineProperty(window, "miniMaxApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ hasApiKey: true }), getUsage
    } });
    render(<I18nProvider locale="zh-CN"><MiniMaxQuotaSettings /></I18nProvider>);

    expect(await screen.findByRole("progressbar", { name: "MiniMAX plan" })).toBeTruthy();
    expect(getUsage).toHaveBeenCalledWith(undefined);
    const toggle = screen.getByRole("button", { name: "MiniMAX 额度" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("progressbar", { name: "MiniMAX plan" })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("progressbar", { name: "MiniMAX plan" })).toBeTruthy();
    expect(getUsage).toHaveBeenCalledTimes(1);
  });
});
