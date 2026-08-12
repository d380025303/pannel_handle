// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileAccessState } from "../../vite-env";
import { TitleBar } from "./TitleBar";

const featureStyles = readFileSync(path.join(process.cwd(), "src/styles/features.css"), "utf8");

function createMobileAccessState(activeDevice: MobileAccessState["activeDevice"] = null): MobileAccessState {
  return {
    config: { enabled: true, interfaceName: "Ethernet", port: 6174 },
    interfaces: [],
    running: true,
    hostname: "pannel-handle.local",
    address: "192.168.1.10",
    canonicalUrl: "http://pannel-handle.local:6174",
    fallbackUrl: "http://192.168.1.10:6174",
    lastError: "",
    devices: [],
    activeDevice
  };
}

describe("TitleBar mobile access layout", () => {
  afterEach(cleanup);

  it("keeps every titlebar region on the explicit four-column row", () => {
    const { container } = render(
      <TitleBar
        activeTitle="PowerShell"
        isMaximized={false}
        mobileAccessState={createMobileAccessState()}
        onOpenSettings={() => undefined}
        onOpenPicker={() => undefined}
        onOpenCreate={() => undefined}
      />
    );

    const titlebar = container.querySelector<HTMLElement>(".custom-titlebar");
    const mobileStatus = container.querySelector<HTMLElement>(".titlebar-mobile-status");

    expect(titlebar).not.toBeNull();
    expect(mobileStatus).not.toBeNull();
    expect(featureStyles).toMatch(/\.custom-titlebar\s*{[^}]*grid-template-columns:\s*auto auto minmax\(0, 1fr\) auto;/s);
    expect(featureStyles).toMatch(/\.titlebar-brand\s*{[^}]*grid-area:\s*brand;/s);
    expect(featureStyles).toMatch(/\.titlebar-mobile-status\s*{[^}]*grid-area:\s*mobile;/s);
    expect(featureStyles).toMatch(/\.titlebar-session\s*{[^}]*grid-area:\s*session;/s);
    expect(featureStyles).toMatch(/\.window-controls\s*{[^}]*grid-area:\s*controls;/s);
  });

  it("keeps the remaining regions assigned when mobile access is hidden", () => {
    const { container } = render(
      <TitleBar
        activeTitle="PowerShell"
        isMaximized={false}
        mobileAccessState={null}
        onOpenSettings={() => undefined}
        onOpenPicker={() => undefined}
        onOpenCreate={() => undefined}
      />
    );

    expect(container.querySelector(".titlebar-mobile-status")).toBeNull();
    expect(container.querySelector(".titlebar-session")?.textContent).toBe("PowerShell");
    expect(container.querySelectorAll(".window-control")).toHaveLength(3);
  });

  it("contains a long connected device name and opens settings", () => {
    const onOpenSettings = vi.fn();
    const deviceName = "Android Chrome living-room terminal with a very long device name";
    const { container } = render(
      <TitleBar
        activeTitle="PowerShell"
        isMaximized={false}
        mobileAccessState={createMobileAccessState({ id: "device-1", name: deviceName, connected: true })}
        onOpenSettings={onOpenSettings}
        onOpenPicker={() => undefined}
        onOpenCreate={() => undefined}
      />
    );

    const statusButton = screen.getByRole("button", { name: deviceName });
    const label = container.querySelector<HTMLElement>(".titlebar-mobile-label");

    expect(statusButton.classList.contains("connected")).toBe(true);
    expect(label?.textContent).toBe(deviceName);
    expect(featureStyles).toMatch(/\.titlebar-mobile-label\s*{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s);

    fireEvent.click(statusButton);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("opens the session library and create dialog from the brand actions", () => {
    const onOpenPicker = vi.fn();
    const onOpenCreate = vi.fn();
    const { container } = render(
      <TitleBar
        activeTitle="PowerShell"
        isMaximized={false}
        mobileAccessState={null}
        onOpenSettings={() => undefined}
        onOpenPicker={onOpenPicker}
        onOpenCreate={onOpenCreate}
      />
    );

    const actionGroup = container.querySelector(".titlebar-actions");
    const libraryButton = screen.getByRole("button", { name: "从库中启动" });
    const createButton = screen.getByRole("button", { name: "新建会话" });

    expect(actionGroup).not.toBeNull();
    expect(actionGroup?.contains(libraryButton)).toBe(true);
    expect(actionGroup?.contains(createButton)).toBe(true);
    expect(libraryButton.compareDocumentPosition(createButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(featureStyles).toMatch(/\.titlebar-action-btn\s*{[^}]*width:\s*28px;[^}]*height:\s*28px;/s);

    fireEvent.click(libraryButton);
    fireEvent.click(createButton);

    expect(onOpenPicker).toHaveBeenCalledTimes(1);
    expect(onOpenCreate).toHaveBeenCalledTimes(1);
  });
});
