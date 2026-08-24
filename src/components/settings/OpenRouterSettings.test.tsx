// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { OpenRouterSettings } from "./OpenRouterSettings";

describe("OpenRouterSettings", () => {
  let verification: { status: "passed" | "partial" | "failed" | "unavailable"; checkedAt: number; error?: string; failedStage?: "responses" | "function_tools" | "codex_tools" };

  beforeEach(() => {
    verification = { status: "failed", checkedAt: 1, error: "Internal Server Error" };
    Object.defineProperty(window, "openRouterApi", {
      configurable: true,
      value: {
        getConfig: vi.fn().mockResolvedValue({ hasApiKey: true, favoriteModelIds: [] }),
        listModels: vi.fn().mockImplementation(async () => [{
          id: "vendor/model",
          name: "Priced Model",
          description: "",
          contextLength: 128000,
          inputModalities: ["text"],
          supportedParameters: ["tools", "tool_choice"],
          pricing: { prompt: "0.000002", completion: "0.000006" },
          compatible: true,
          verification: { ...verification }
        }]),
        refreshModels: vi.fn(),
        saveApiKey: vi.fn(),
        clearApiKey: vi.fn(),
        test: vi.fn(),
        verifyModels: vi.fn().mockImplementation(async () => {
          verification = { status: "passed", checkedAt: 2 };
          return [{ modelId: "vendor/model", ...verification }];
        }),
        setFavorites: vi.fn()
      }
    });
  });

  afterEach(cleanup);

  it("shows input and output prices in the compatible model list", async () => {
    render(<I18nProvider locale="zh-CN"><OpenRouterSettings /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: /OpenRouter/ }));

    expect(await screen.findByText("$2/M 输入 · $6/M 输出")).toBeTruthy();
    expect(screen.getByText(/检测失败：Internal Server Error/)).toBeTruthy();
  });

  it("retries a failed model verification and refreshes its status", async () => {
    render(<I18nProvider locale="zh-CN"><OpenRouterSettings /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: /OpenRouter/ }));
    fireEvent.click(await screen.findByRole("button", { name: "检测" }));

    await vi.waitFor(() => expect(window.openRouterApi.verifyModels).toHaveBeenCalledWith({ modelIds: ["vendor/model"], force: true }));
    expect(await screen.findByText("已验证")).toBeTruthy();
  });

  it("shows a partial model's failed stage and keeps it eligible for favorites", async () => {
    verification = { status: "partial", checkedAt: 2, failedStage: "codex_tools", error: "custom tools unsupported" };
    render(<I18nProvider locale="zh-CN"><OpenRouterSettings /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: /OpenRouter/ }));

    expect(await screen.findByText(/部分兼容：完整 Codex 工具协议 · custom tools unsupported/)).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(false);
  });
});
