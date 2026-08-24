// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { CodexBackendFields } from "./CodexBackendFields";

describe("CodexBackendFields", () => {
  beforeEach(() => {
    Object.defineProperty(window, "openRouterApi", {
      configurable: true,
      value: {
        listModels: vi.fn().mockResolvedValue({
          fetchedAt: 1,
          models: [{ id: "openai/gpt-5.4", name: "GPT-5.4", contextLength: 128000, promptPrice: "0.000002", completionPrice: "0.000008" }]
        })
      }
    });
  });

  afterEach(cleanup);

  it("loads model suggestions while keeping manual slug input available", async () => {
    render(
      <I18nProvider locale="en-US">
        <CodexBackendFields backend="openrouter" model="custom/model" onBackendChange={vi.fn()} onModelChange={vi.fn()} />
      </I18nProvider>
    );

    expect((screen.getByDisplayValue("custom/model") as HTMLInputElement).value).toBe("custom/model");
    await waitFor(() => expect(window.openRouterApi.listModels).toHaveBeenCalled());
    expect(document.querySelector('option[value="openai/gpt-5.4"]')?.getAttribute("label")).toContain("128K ctx");
  });
});
