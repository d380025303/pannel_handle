// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { OpenRouterModel, OpenRouterModelVerification } from "../../vite-env";
import { OpenRouterSettings } from "./OpenRouterSettings";

describe("OpenRouterSettings", () => {
  let verification: OpenRouterModelVerification;
  let models: OpenRouterModel[];

  beforeEach(() => {
    verification = { status: "failed", checkedAt: 1, error: "Internal Server Error" };
    models = [{
      id: "vendor/model",
      name: "Priced Model",
      description: "",
      contextLength: 128000,
      inputModalities: ["text"],
      supportedParameters: ["tools", "tool_choice"],
      pricing: { prompt: "0.000002", completion: "0.000006" },
      compatible: true,
      verification: { ...verification }
    }];
    Object.defineProperty(window, "openRouterApi", {
      configurable: true,
      value: {
        getConfig: vi.fn().mockResolvedValue({ hasApiKey: true, favoriteModelIds: [] }),
        listModels: vi.fn().mockImplementation(async () => models.map(model => model.id === "vendor/model" ? { ...model, verification: { ...verification } } : model)),
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
    Object.defineProperty(window, "naraRouterApi", {
      configurable: true,
      value: {
        getConfig: vi.fn().mockResolvedValue({ hasApiKey: true, favoriteModelIds: [] }),
        listModels: vi.fn().mockImplementation(async () => models),
        refreshModels: vi.fn(),
        saveApiKey: vi.fn(),
        clearApiKey: vi.fn(),
        test: vi.fn(),
        verifyModels: vi.fn().mockResolvedValue([{ modelId: "vendor/model", status: "passed", checkedAt: 2 }]),
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

  it("renders an independent NaraRouter catalog with provider pricing when available", async () => {
    render(<I18nProvider locale="zh-CN"><OpenRouterSettings provider="nararouter" /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: /NaraRouter/ }));

    expect(await screen.findByText("$2/M 输入 · $6/M 输出")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "仅看免费模型" })).toBeTruthy();
    expect(window.naraRouterApi.listModels).toHaveBeenCalled();
    expect(window.openRouterApi.listModels).not.toHaveBeenCalled();
  });

  it("filters NaraRouter models by official free-tier eligibility", async () => {
    models = [
      { ...models[0], id: "agnes-2.0-flash", name: "Agnes", freeTierEligible: true },
      { ...models[0], id: "glm-5.3-free", name: "GLM Free", freeTierEligible: false }
    ];
    render(<I18nProvider locale="zh-CN"><OpenRouterSettings provider="nararouter" /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: /NaraRouter/ }));

    fireEvent.click(await screen.findByRole("checkbox", { name: "仅看免费模型" }));
    expect(screen.getByText("Agnes")).toBeTruthy();
    expect(screen.queryByText("GLM Free")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
    expect(screen.getByText("没有匹配的兼容模型。")).toBeTruthy();
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
    expect((screen.getAllByRole("checkbox")[1] as HTMLInputElement).disabled).toBe(false);
  });

  it("explains a free-model rate limit instead of exposing only the provider error", async () => {
    verification = { status: "unavailable", checkedAt: 2, errorKind: "rate_limit", error: "Rate exceeded" };
    render(<I18nProvider locale="zh-CN"><OpenRouterSettings /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: /OpenRouter/ }));

    expect(await screen.findByText(/免费模型可能已达到频率或每日额度限制/)).toBeTruthy();
    expect(screen.queryByText(/Rate exceeded/)).toBeNull();
  });

  it("explains a rejected basic Responses request consistently", async () => {
    verification = {
      status: "failed",
      checkedAt: 2,
      failedStage: "responses",
      errorKind: "unsupported",
      error: "The model rejected this request."
    };
    window.openRouterApi.verifyModels = vi.fn().mockResolvedValue([{ modelId: "vendor/model", ...verification }]);
    render(<I18nProvider locale="zh-CN"><OpenRouterSettings /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: /OpenRouter/ }));

    expect(await screen.findByText(/基础 Responses · 当前模型未通过 Codex 所需的 Responses 请求，请更换模型。 服务端详情：The model rejected this request./)).toBeTruthy();
    expect((screen.getAllByRole("checkbox")[1] as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "检测" }));
    expect(await screen.findByText(/vendor\/model：检测失败：基础 Responses · 当前模型未通过 Codex 所需的 Responses 请求/)).toBeTruthy();
  });

  it("filters free variants and combines the filter with search", async () => {
    models = [
      ...models,
      { ...models[0], id: "vendor/alpha:free", name: "Alpha Free", pricing: { prompt: "0", completion: "0" } },
      { ...models[0], id: "openrouter/free", name: "Free Models Router", pricing: { prompt: "0", completion: "0" } },
      { ...models[0], id: "vendor/zero-priced", name: "Zero Priced", pricing: { prompt: "0", completion: "0" } }
    ];
    render(<I18nProvider locale="zh-CN"><OpenRouterSettings /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: /OpenRouter/ }));

    fireEvent.click(await screen.findByRole("checkbox", { name: "仅看免费模型" }));
    expect(screen.getByText("Alpha Free")).toBeTruthy();
    expect(screen.getByText("Free Models Router")).toBeTruthy();
    expect(screen.queryByText("Priced Model")).toBeNull();
    expect(screen.queryByText("Zero Priced")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "仅看免费模型" }));
    expect(screen.getByText("Priced Model")).toBeTruthy();
    expect(screen.getByText("Zero Priced")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "仅看免费模型" }));

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "alpha" } });
    expect(screen.getByText("Alpha Free")).toBeTruthy();
    expect(screen.queryByText("Free Models Router")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
    expect(screen.getByText("没有匹配的兼容模型。")).toBeTruthy();
  });
});
