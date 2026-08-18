// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { IdeaBridgeApi, IdeaBridgeSnapshot } from "../../vite-env";
import { IdeaRunPanel } from "./IdeaRunPanel";

const snapshot: IdeaBridgeSnapshot = {
  protocolVersion: 1,
  updatedAt: Date.now(),
  connections: [{
    bridgeId: "bridge-1",
    pid: 100,
    productName: "IntelliJ IDEA",
    productVersion: "2025.2.6.1",
    buildNumber: "252.28539.33",
    status: "connected",
    projects: [{
      id: "project-1",
      name: "Demo",
      path: "C:\\demo",
      configurations: [{
        id: "config-1",
        name: "DemoApplication",
        type: "Spring Boot",
        temporary: false,
        allowParallel: false,
        supportsRun: true,
        supportsDebug: true,
        instances: []
      }]
    }]
  }]
};

function api(overrides: Partial<IdeaBridgeApi> = {}): IdeaBridgeApi {
  return {
    getSnapshot: vi.fn(async () => snapshot),
    start: vi.fn(async () => ({ accepted: true })),
    stop: vi.fn(async () => ({ accepted: true })),
    stopAll: vi.fn(async () => ({ accepted: true })),
    restart: vi.fn(async () => ({ accepted: true })),
    onChanged: vi.fn(() => () => undefined),
    ...overrides
  };
}

describe("IdeaRunPanel", () => {
  beforeEach(() => {
    window.ideaBridgeApi = api();
  });

  it("lists IDEA projects and starts a run configuration", async () => {
    const user = userEvent.setup();
    render(<I18nProvider locale="zh-CN"><IdeaRunPanel /></I18nProvider>);
    expect(await screen.findByText("DemoApplication")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "运行 DemoApplication" }));
    await waitFor(() => expect(window.ideaBridgeApi.start).toHaveBeenCalledWith("bridge-1", "project-1", "config-1", "run"));
  });

  it("explains how to connect when no bridge is available", async () => {
    window.ideaBridgeApi = api({ getSnapshot: vi.fn(async () => ({ ...snapshot, connections: [] })) });
    render(<I18nProvider locale="zh-CN"><IdeaRunPanel /></I18nProvider>);
    expect(await screen.findByText("未连接到 IDEA")).toBeTruthy();
    expect(screen.getByText("idea-plugin/build/distributions")).toBeTruthy();
  });
});
