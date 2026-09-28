// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { CodexBackendFields } from "./CodexBackendFields";

describe("CodexBackendFields", () => {
  beforeEach(() => {
    Object.defineProperty(window, "openRouterApi", {
      configurable: true,
      value: {
        getConfig: vi.fn().mockResolvedValue({ hasApiKey: true }),
        listModels: vi.fn().mockResolvedValue([{
          id: "vendor/model",
          name: "Priced Model",
          description: "",
          contextLength: 128000,
          inputModalities: ["text"],
          supportedParameters: ["tools", "tool_choice"],
          pricing: { prompt: "0.000002", completion: "0.000006" },
          compatible: true,
          verification: { status: "passed", checkedAt: 1 }
        }])
      }
    });
    Object.defineProperty(window, "naraRouterApi", {
      configurable: true,
      value: {
        getConfig: vi.fn().mockResolvedValue({ hasApiKey: true }),
        listModels: vi.fn().mockResolvedValue([{
          id: "gpt-test",
          name: "Nara GPT",
          description: "",
          contextLength: 128000,
          inputModalities: ["text"],
          supportedParameters: [],
          pricing: { prompt: "0.000001" },
          compatible: true,
          verification: { status: "passed", checkedAt: 1 }
        }])
      }
    });
    Object.defineProperty(window, "miniMaxApi", {
      configurable: true,
      value: {
        getConfig: vi.fn().mockResolvedValue({ hasApiKey: true }),
        listModels: vi.fn().mockResolvedValue([{
          id: "MiniMax-M2.5",
          name: "MiniMax M2.5",
          description: "",
          contextLength: 204800,
          inputModalities: ["text"],
          supportedParameters: ["tools", "tool_choice"],
          pricing: {},
          compatible: true,
          verification: { status: "passed", checkedAt: 1 }
        }])
      }
    });
  });

  afterEach(cleanup);

  it("does not offer CodeBuddy as a Codex backend", () => {
    render(<I18nProvider locale="zh-CN"><CodexBackendFields backend="openai" onBackendChange={vi.fn()} onModelChange={vi.fn()} /></I18nProvider>);
    expect(screen.queryByRole("button", { name: "CodeBuddy" })).toBeNull();
  });

  it("shows input and output prices in the verified model selector", async () => {
    render(
      <I18nProvider locale="en-US">
        <CodexBackendFields backend="openrouter" model="vendor/model" onBackendChange={vi.fn()} onModelChange={vi.fn()} />
      </I18nProvider>
    );

    expect(await screen.findByRole("option", { name: "Priced Model · vendor/model · Verified · $2/M input · $6/M output" })).toBeTruthy();
  });

  it("omits an unverified model and reports the requirement", async () => {
    vi.mocked(window.openRouterApi.listModels).mockResolvedValueOnce([{
      id: "vendor/model",
      name: "Pending Model",
      description: "",
      contextLength: 128000,
      inputModalities: ["text"],
      supportedParameters: ["tools", "tool_choice"],
      pricing: {},
      compatible: true
    }]);
    const onReadyChange = vi.fn();
    render(
      <I18nProvider locale="zh-CN">
        <CodexBackendFields backend="openrouter" model="vendor/model" onBackendChange={vi.fn()} onModelChange={vi.fn()} onReadyChange={onReadyChange} />
      </I18nProvider>
    );

    await screen.findByRole("option", { name: "选择已验证模型" });
    await vi.waitFor(() => expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true));
    expect(screen.queryByRole("option", { name: /Pending Model/ })).toBeNull();
    expect(await screen.findByText("请先在设置中检测至少一个兼容模型。")).toBeTruthy();
    await vi.waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(false));
  });

  it("allows a partial model only after the experimental risk is acknowledged", async () => {
    vi.mocked(window.openRouterApi.listModels).mockResolvedValueOnce([{
      id: "vendor/model",
      name: "Partial Model",
      description: "",
      contextLength: 128000,
      inputModalities: ["text"],
      supportedParameters: ["tools", "tool_choice"],
      pricing: {},
      compatible: true,
      verification: { status: "partial", checkedAt: 1, failedStage: "codex_tools", error: "custom tools unsupported" }
    }]);
    const onReadyChange = vi.fn();
    const onAcknowledged = vi.fn();
    const { rerender } = render(
      <I18nProvider locale="zh-CN">
        <CodexBackendFields backend="openrouter" model="vendor/model" experimentalAcknowledged={false} onBackendChange={vi.fn()} onModelChange={vi.fn()} onExperimentalAcknowledgedChange={onAcknowledged} onReadyChange={onReadyChange} />
      </I18nProvider>
    );

    const option = await screen.findByRole("option", { name: /Partial Model/ });
    expect((option as HTMLOptionElement).disabled).toBe(false);
    expect(screen.getByText("请先确认部分兼容模型的实验风险。")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onAcknowledged).toHaveBeenCalledWith(true);

    rerender(
      <I18nProvider locale="zh-CN">
        <CodexBackendFields backend="openrouter" model="vendor/model" experimentalAcknowledged onBackendChange={vi.fn()} onModelChange={vi.fn()} onExperimentalAcknowledgedChange={onAcknowledged} onReadyChange={onReadyChange} />
      </I18nProvider>
    );
    await vi.waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true));
  });

  it("requires explicit NaraRouter model selection and reports readiness", async () => {
    const onReadyChange = vi.fn();
    function Harness() {
      const [model, setModel] = useState<string>();
      return <CodexBackendFields backend="nararouter" model={model} onBackendChange={vi.fn()} onModelChange={setModel} onReadyChange={onReadyChange} />;
    }
    render(<I18nProvider locale="zh-CN"><Harness /></I18nProvider>);

    expect(await screen.findByRole("option", { name: /Nara GPT · gpt-test · 已验证/ })).toBeTruthy();
    expect(onReadyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "gpt-test" } });
    await vi.waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true));
  });

  it("requires explicit MiniMax model selection and reports readiness", async () => {
    const onReadyChange = vi.fn();
    function Harness() {
      const [model, setModel] = useState<string>();
      return <CodexBackendFields backend="minimax" model={model} onBackendChange={vi.fn()} onModelChange={setModel} onReadyChange={onReadyChange} />;
    }
    render(<I18nProvider locale="zh-CN"><Harness /></I18nProvider>);

    expect(await screen.findByRole("option", { name: /MiniMax M2.5 · MiniMax-M2.5 · 已验证/ })).toBeTruthy();
    expect(onReadyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "MiniMax-M2.5" } });
    await vi.waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true));
  });
});
