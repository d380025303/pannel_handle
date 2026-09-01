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
        getConfig: vi.fn().mockResolvedValue({ hasApiKey: true, favoriteModelIds: ["vendor/model"], defaultModelId: "vendor/model" }),
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
    Object.defineProperty(window, "codeBuddyCodexApi", {
      configurable: true,
      value: {
        getStatus: vi.fn().mockResolvedValue({ available: true, version: "2.142.0", supportedMinor: "2.142", experimental: true }),
        listModels: vi.fn().mockResolvedValue([{ id: "glm-5.2", name: "glm-5.2" }]),
        verifyModel: vi.fn().mockResolvedValue({ modelId: "glm-5.2", status: "passed", checkedAt: 1, stages: [] })
      }
    });
  });

  afterEach(cleanup);

  it("shows input and output prices in the favorite model selector", async () => {
    render(
      <I18nProvider locale="en-US">
        <CodexBackendFields backend="openrouter" model="vendor/model" onBackendChange={vi.fn()} onModelChange={vi.fn()} />
      </I18nProvider>
    );

    expect(await screen.findByRole("option", { name: "Priced Model · vendor/model · Verified · $2/M input · $6/M output" })).toBeTruthy();
  });

  it("keeps an unverified favorite disabled and reports the requirement", async () => {
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

    const option = await screen.findByRole("option", { name: /Pending Model/ });
    expect((option as HTMLOptionElement).disabled).toBe(true);
    expect(screen.getByText("请先在设置中检测并保存至少一个兼容模型。")).toBeTruthy();
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

  it("verifies a CodeBuddy model and requires the private-bridge acknowledgement", async () => {
    const onAcknowledged = vi.fn();
    function Harness() {
      const [model, setModel] = useState<string>();
      return <CodexBackendFields backend="codebuddy" model={model} onBackendChange={vi.fn()} onModelChange={setModel} onExperimentalAcknowledgedChange={onAcknowledged} />;
    }
    render(
      <I18nProvider locale="zh-CN">
        <Harness />
      </I18nProvider>
    );
    const selector = await screen.findByRole("combobox");
    fireEvent.change(selector, { target: { value: "glm-5.2" } });
    await vi.waitFor(() => expect(window.codeBuddyCodexApi.verifyModel).toHaveBeenCalledWith({ modelId: "glm-5.2" }));
    expect(await screen.findByText(/私有桥仅兼容 CodeBuddy 2.142.x/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onAcknowledged).toHaveBeenCalledWith(true);
  });
});
