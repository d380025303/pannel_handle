// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { CodeBuddyCodexSettings } from "./CodeBuddyCodexSettings";

describe("CodeBuddyCodexSettings", () => {
  let config: { favoriteModelIds: string[]; defaultModelId?: string; catalogVersion?: string; experimentalAcknowledged: boolean };
  let models: Array<{ id: string; name: string; promotions?: Array<{ id: string; label: string; color?: string; descriptionZh?: string; descriptionEn?: string }>; verification?: { status: "passed" | "failed"; checkedAt: number } }>;

  beforeEach(() => {
    config = { favoriteModelIds: [], catalogVersion: "2.142.0", experimentalAcknowledged: false };
    models = [{ id: "glm-5.3", name: "glm-5.3", verification: { status: "passed", checkedAt: 1 } }];
    Object.defineProperty(window, "codeBuddyCodexApi", {
      configurable: true,
      value: {
        getConfig: vi.fn(async () => ({ ...config, favoriteModelIds: [...config.favoriteModelIds] })),
        getStatus: vi.fn(),
        listModels: vi.fn(async () => models),
        refreshModels: vi.fn(async () => models),
        verifyModel: vi.fn(async () => ({ modelId: "glm-5.3", status: "passed", checkedAt: 2 })),
        setFavorites: vi.fn(async input => {
          config = { ...config, favoriteModelIds: input.favoriteModelIds, defaultModelId: input.defaultModelId };
          return config;
        }),
        setExperimentalAcknowledged: vi.fn(async input => {
          config = { ...config, experimentalAcknowledged: input.acknowledged };
          return config;
        })
      }
    });
  });

  afterEach(cleanup);

  it("saves verified favorites and the version-bound global acknowledgement", async () => {
    render(<I18nProvider locale="zh-CN"><CodeBuddyCodexSettings /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: /CodeBuddy Codex/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "glm-5.3" }));
    const saveButton = screen.getByRole("button", { name: "保存收藏与默认模型" });
    await vi.waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton);
    await vi.waitFor(() => expect(window.codeBuddyCodexApi.setFavorites).toHaveBeenCalledWith({ favoriteModelIds: ["glm-5.3"], defaultModelId: "glm-5.3" }));
    const acknowledgement = screen.getAllByRole("checkbox").find(input => input.getAttribute("aria-label") !== "glm-5.3")!;
    fireEvent.click(acknowledgement);
    await vi.waitFor(() => expect(window.codeBuddyCodexApi.setExperimentalAcknowledged).toHaveBeenCalledWith({ acknowledged: true }));
  });

  it("shows the current WorkBuddy promotion badge and localized details", async () => {
    models = [{ id: "hy3", name: "混元 3", promotions: [{ id: "free", label: "限时免费", color: "#FF0000", descriptionZh: "每日赠送免费额度。", descriptionEn: "Free daily credits." }], verification: { status: "passed", checkedAt: 1 } }];
    render(<I18nProvider locale="zh-CN"><CodeBuddyCodexSettings /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: /CodeBuddy Codex/ }));
    expect(await screen.findByText("限时免费")).toBeTruthy();
    expect(screen.getByText("每日赠送免费额度。")).toBeTruthy();
  });
});
