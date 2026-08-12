// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { MobileAccessState } from "../../vite-env";
import { MobileAccessSettings } from "./MobileAccessSettings";

const mobileAccessState: MobileAccessState = {
  config: { enabled: true, interfaceName: "Ethernet", port: 6174 },
  interfaces: [{ name: "Ethernet", address: "192.168.1.10" }],
  running: true,
  hostname: "pannel-handle.local",
  address: "192.168.1.10",
  canonicalUrl: "http://pannel-handle.local:6174",
  fallbackUrl: "http://192.168.1.10:6174",
  lastError: "",
  devices: [],
  activeDevice: null
};

describe("MobileAccessSettings", () => {
  beforeEach(() => {
    Object.defineProperty(window, "mobileAccessApi", {
      configurable: true,
      value: {
        getState: vi.fn().mockResolvedValue(mobileAccessState),
        updateConfig: vi.fn(),
        createPairing: vi.fn(),
        listAudit: vi.fn().mockResolvedValue([]),
        revokeDevice: vi.fn(),
        disconnectDevice: vi.fn(),
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
});
