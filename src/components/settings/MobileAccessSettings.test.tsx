// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { MobileAccessState } from "../../vite-env";
import { MobileAccessSettings } from "./MobileAccessSettings";

const mobileAccessState: MobileAccessState = {
  config: { enabled: true, interfaceName: "Ethernet", port: 6174, hasPassword: true },
  interfaces: [{ name: "Ethernet", address: "192.168.1.10" }],
  running: true,
  hostname: "pannel-handle.local",
  address: "192.168.1.10",
  canonicalUrl: "http://pannel-handle.local:6174",
  fallbackUrl: "http://192.168.1.10:6174",
  localUrl: "http://127.0.0.1:6174",
  lastError: "",
  activeConnections: []
};

describe("MobileAccessSettings", () => {
  beforeEach(() => {
    Object.defineProperty(window, "mobileAccessApi", {
      configurable: true,
      value: {
        getState: vi.fn().mockResolvedValue(mobileAccessState),
        updateConfig: vi.fn(),
        setPassword: vi.fn().mockResolvedValue(mobileAccessState),
        listAudit: vi.fn().mockResolvedValue([]),
        disconnectConnection: vi.fn(),
        onStateChanged: vi.fn().mockReturnValue(() => undefined)
      }
    });
  });

  afterEach(cleanup);

  it("uses the same compact disclosure chevron as the other settings sections", async () => {
    const { container } = render(
      <I18nProvider locale="zh-CN">
        <MobileAccessSettings />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(container.querySelector(".collapsible-chevron")?.textContent).toBe("▾");
    });
  });

  it("saves a mobile password without showing it after submission", async () => {
    render(<I18nProvider locale="zh-CN"><MobileAccessSettings /></I18nProvider>);
    const input = await screen.findByLabelText(/移动访问密码/);
    fireEvent.change(input, { target: { value: "strong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
    await waitFor(() => expect(window.mobileAccessApi.setPassword).toHaveBeenCalledWith("strong-password"));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  });

  it("shows the local address alongside the LAN addresses", async () => {
    render(<I18nProvider locale="zh-CN"><MobileAccessSettings /></I18nProvider>);
    expect(await screen.findByText("http://127.0.0.1:6174")).toBeTruthy();
  });
});
