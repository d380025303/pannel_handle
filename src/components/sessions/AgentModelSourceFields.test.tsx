// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentModelSourceFields } from "./AgentModelSourceFields";

describe("AgentModelSourceFields", () => {
  it("shows shared favorites but enables only models verified for the selected Agent", async () => {
    window.openRouterApi = {
      getConfig: vi.fn(async () => ({ hasApiKey: true, favoriteModelIds: ["vendor/a", "vendor/b"] })),
      listModels: vi.fn(async () => [
        { id: "vendor/a", name: "A", agentVerifications: { opencode: { status: "passed", checkedAt: 1 } } },
        { id: "vendor/b", name: "B", agentVerifications: { codebuddy: { status: "passed", checkedAt: 1 } } }
      ]),
      refreshModels: vi.fn(), saveApiKey: vi.fn(), clearApiKey: vi.fn(), test: vi.fn(), verifyModels: vi.fn(), verifyAgentModels: vi.fn(), setFavorites: vi.fn()
    } as unknown as Window["openRouterApi"];
    const onModelChange = vi.fn();
    render(<AgentModelSourceFields agent="opencode" source="openrouter" onSourceChange={vi.fn()} onModelChange={onModelChange} onReadyChange={vi.fn()} />);
    const select = await screen.findByRole("combobox") as HTMLSelectElement;
    await vi.waitFor(() => expect(select.options).toHaveLength(3));
    expect(select.options[1].disabled).toBe(false);
    expect(select.options[2].disabled).toBe(true);
    fireEvent.change(select, { target: { value: "vendor/a" } });
    expect(onModelChange).toHaveBeenCalledWith("vendor/a");
  });
});
