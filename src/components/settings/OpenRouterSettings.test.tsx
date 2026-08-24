// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { OpenRouterSettings } from "./OpenRouterSettings";

describe("OpenRouterSettings", () => {
  const api = {
    getConfig: vi.fn().mockResolvedValue({ hasApiKey: false }),
    setApiKey: vi.fn().mockResolvedValue({ ok: true, config: { hasApiKey: true }, keyLabel: "sk-or-...123" }),
    clearApiKey: vi.fn(),
    test: vi.fn(),
    listModels: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "openRouterApi", { configurable: true, value: api });
  });

  afterEach(cleanup);

  it("sends a newly entered key to the main-process API and clears the input", async () => {
    render(<I18nProvider locale="en-US"><OpenRouterSettings /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: /OpenRouter/ }));
    const input = screen.getByPlaceholderText("sk-or-v1-...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-or-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.setApiKey).toHaveBeenCalledWith("sk-or-secret"));
    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.getByText(/sk-or-\.\.\.123/)).toBeTruthy();
  });
});
