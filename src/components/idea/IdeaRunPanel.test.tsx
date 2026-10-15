// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
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

  it("keeps stop available for a removed configuration", async () => {
    const value = structuredClone(snapshot);
    const configuration = value.connections[0].projects[0].configurations[0];
    configuration.supportsRun = false;
    configuration.supportsDebug = false;
    configuration.instances = [{ id: "instance-1", executionId: 1, name: "process-1",
      mode: "run", status: "running", startedAt: Date.now() }];
    window.ideaBridgeApi = api({ getSnapshot: vi.fn(async () => value) });
    const user = userEvent.setup();
    const view = render(<I18nProvider locale="zh-CN"><IdeaRunPanel /></I18nProvider>);
    await within(view.container).findByText("process-1");
    const panel = within(view.container);
    for (const name of ["\u8fd0\u884c DemoApplication", "\u8c03\u8bd5 DemoApplication", "\u91cd\u542f process-1"]) {
      expect((panel.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    await user.click(panel.getByRole("button", { name: "\u505c\u6b62 process-1" }));
    expect(window.ideaBridgeApi.stop).toHaveBeenCalledWith("bridge-1", "instance-1");
    expect(window.ideaBridgeApi.restart).not.toHaveBeenCalled();
  });

  it("explains how to connect when no bridge is available", async () => {
    window.ideaBridgeApi = api({ getSnapshot: vi.fn(async () => ({ ...snapshot, connections: [] })) });
    render(<I18nProvider locale="zh-CN"><IdeaRunPanel /></I18nProvider>);
    expect(await screen.findByText("未连接到 IDEA")).toBeTruthy();
    expect(screen.getByText("idea-plugin/build/distributions")).toBeTruthy();
  });
});
