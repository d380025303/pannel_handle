// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { OpenRouterModel, OpenRouterModelVerification } from "../../vite-env";
import { ModelServicesSettings, OpenRouterSettings } from "./OpenRouterSettings";

describe("model services settings", () => {
  let models: OpenRouterModel[];
  let verification: OpenRouterModelVerification;

  const renderSettings = (provider?: "openrouter" | "nararouter" | "minimax") => render(
    <I18nProvider locale="zh-CN">{provider ? <OpenRouterSettings provider={provider} /> : <ModelServicesSettings />}</I18nProvider>
  );
  const makeApi = () => ({
    getConfig: vi.fn().mockResolvedValue({ hasApiKey: true }),
    listModels: vi.fn().mockImplementation(async () => models.map(model => model.id === "vendor/model" ? { ...model, verification: { ...verification } } : model)),
    refreshModels: vi.fn().mockImplementation(async () => models),
    saveApiKey: vi.fn().mockResolvedValue({ hasApiKey: true }),
    clearApiKey: vi.fn().mockResolvedValue({ hasApiKey: false }),
    test: vi.fn().mockResolvedValue({ ok: true }),
    verifyModels: vi.fn().mockImplementation(async () => {
      verification = { status: "passed", checkedAt: 2 };
      return [{ modelId: "vendor/model", ...verification }];
    }),
    verifyAgentModels: vi.fn().mockImplementation(async ({ agent }: { agent: string }) => {
      models = models.map(model => model.id === "vendor/model" ? { ...model, agentVerifications: { ...model.agentVerifications, [agent]: { status: "passed", checkedAt: 2 } } } : model);
      return [{ modelId: "vendor/model", status: "passed", checkedAt: 2 }];
    })
  });

  beforeEach(() => {
    verification = { status: "failed", checkedAt: 1, error: "Internal Server Error" };
    models = [{ id: "vendor/model", name: "Priced Model", description: "", contextLength: 128000, inputModalities: ["text"], supportedParameters: ["tools", "tool_choice"], pricing: { prompt: "0.000002", completion: "0.000006" }, compatible: true }];
    for (const name of ["openRouterApi", "naraRouterApi", "miniMaxApi"] as const) Object.defineProperty(window, name, { configurable: true, value: makeApi() });
  });
  afterEach(cleanup);

  it("switches provider without mixing credentials or catalogs", async () => {
    renderSettings();
    const selector = screen.getByRole("group", { name: "选择模型供应商" });
    expect(within(selector).getByRole("button", { name: /OpenRouter/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByLabelText("OpenRouter API Key"), { target: { value: "unsaved-key" } });
    fireEvent.click(within(selector).getByRole("button", { name: /NaraRouter/ }));
    expect(await screen.findByText("NaraRouter API Key")).toBeTruthy();
    expect(window.naraRouterApi.listModels).toHaveBeenCalled();
    expect(within(selector).getByRole("button", { name: /NaraRouter/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(selector).getByRole("button", { name: /OpenRouter/ }));
    expect((screen.getByLabelText("OpenRouter API Key") as HTMLInputElement).value).toBe("unsaved-key");
  });

  it("separates connection, catalog, and CLI verification", async () => {
    renderSettings("openrouter");
    expect(screen.getByRole("region", { name: "配置连接" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "查找模型" })).toBeTruthy();
    const verificationRegion = screen.getByRole("region", { name: "验证 CLI 兼容性" });
    expect(await screen.findByText("$2/M 输入 · $6/M 输出")).toBeTruthy();
    expect(within(verificationRegion).getByText(/检测失败：Internal Server Error/)).toBeTruthy();
    expect(within(verificationRegion).getAllByRole("button", { name: "检测" })).toHaveLength(3);
  });

  it("keeps the NaraRouter free tier filter and search together", async () => {
    models = [
      { ...models[0], id: "agnes-2.0-flash", name: "Agnes", freeTierEligible: true },
      { ...models[0], id: "glm-5.3-free", name: "GLM Free", freeTierEligible: false }
    ];
    renderSettings("nararouter");
    fireEvent.click(await screen.findByRole("checkbox", { name: "仅看免费模型" }));
    expect(screen.getByRole("button", { name: /Agnes/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /GLM Free/ })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索模型" }), { target: { value: "missing" } });
    expect(screen.getByText("没有匹配的模型。")).toBeTruthy();
  });

  it("keeps OpenRouter free variants distinct from zero priced models", async () => {
    models = [
      ...models,
      { ...models[0], id: "vendor/alpha:free", name: "Alpha Free", pricing: { prompt: "0", completion: "0" } },
      { ...models[0], id: "openrouter/free", name: "Free Models Router", pricing: { prompt: "0", completion: "0" } },
      { ...models[0], id: "vendor/zero-priced", name: "Zero Priced", pricing: { prompt: "0", completion: "0" } }
    ];
    renderSettings("openrouter");
    fireEvent.click(await screen.findByRole("checkbox", { name: "仅看免费模型" }));
    expect(screen.getByRole("button", { name: /Alpha Free/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Free Models Router/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Zero Priced/ })).toBeNull();
  });

  it("selects a model and verifies Codex, OpenCode, and CodeBuddy independently", async () => {
    models.push({ ...models[0], id: "vendor/other", name: "Other Model" });
    renderSettings("openrouter");
    fireEvent.click(await screen.findByRole("button", { name: /Other Model/ }));
    expect(screen.getByText("vendor/other", { selector: ".model-selection-summary small" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Priced Model/ }));
    const region = screen.getByRole("region", { name: "验证 CLI 兼容性" });
    const buttons = within(region).getAllByRole("button", { name: "检测" });
    fireEvent.click(buttons[0]);
    await vi.waitFor(() => expect(window.openRouterApi.verifyModels).toHaveBeenCalledWith({ modelIds: ["vendor/model"], force: true }));
    await vi.waitFor(() => expect(within(region).getAllByText("已验证").length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(within(region).getAllByRole("button", { name: "检测" })).toHaveLength(3));
    fireEvent.click(within(region).getAllByRole("button", { name: "检测" })[1]);
    await vi.waitFor(() => expect(window.openRouterApi.verifyAgentModels).toHaveBeenCalledWith({ agent: "opencode", modelIds: ["vendor/model"], force: true }));
    await vi.waitFor(() => expect(within(region).getAllByRole("button", { name: "检测" })).toHaveLength(3));
    fireEvent.click(within(region).getAllByRole("button", { name: "检测" })[2]);
    await vi.waitFor(() => expect(window.openRouterApi.verifyAgentModels).toHaveBeenCalledWith({ agent: "codebuddy", modelIds: ["vendor/model"], force: true }));
  });

  it("shows partial Codex compatibility and provider errors in the selected model", async () => {
    verification = { status: "partial", checkedAt: 2, failedStage: "codex_tools", error: "custom tools unsupported" };
    renderSettings("openrouter");
    const region = screen.getByRole("region", { name: "验证 CLI 兼容性" });
    expect(await within(region).findByText(/部分兼容：完整 Codex 工具协议 · custom tools unsupported/)).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  it("explains rate limits and rejected Responses requests", async () => {
    verification = { status: "unavailable", checkedAt: 2, errorKind: "rate_limit", error: "Rate exceeded" };
    const view = renderSettings("openrouter");
    expect(await screen.findByText(/免费模型可能已达到频率或每日额度限制/)).toBeTruthy();
    expect(screen.queryByText(/Rate exceeded/)).toBeNull();
    view.unmount();
    verification = { status: "failed", checkedAt: 2, failedStage: "responses", errorKind: "unsupported", error: "The model rejected this request." };
    renderSettings("openrouter");
    expect(await screen.findByText(/基础 Responses · 当前模型未通过 Codex 所需的 Responses 请求/)).toBeTruthy();
  });
});
