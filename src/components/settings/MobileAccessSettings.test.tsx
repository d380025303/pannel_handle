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

  it("shows only the local address and the adapter error when LAN is unavailable", async () => {
    vi.mocked(window.mobileAccessApi.getState).mockResolvedValueOnce({
      ...mobileAccessState, address: "", canonicalUrl: "", fallbackUrl: "",
      lastError: "选择的局域网网卡不可用，请重新选择。"
    });
    render(<I18nProvider locale="zh-CN"><MobileAccessSettings /></I18nProvider>);
    expect(await screen.findByText("http://127.0.0.1:6174")).toBeTruthy();
    expect(screen.queryByText("http://192.168.1.10:6174")).toBeNull();
    expect(screen.getByText("选择的局域网网卡不可用，请重新选择。")).toBeTruthy();
    expect(screen.getByText(/当前仅可在本机打开/)).toBeTruthy();
  });

  it("shows an unavailable saved adapter instead of silently selecting the first available one", async () => {
    vi.mocked(window.mobileAccessApi.getState).mockResolvedValueOnce({
      ...mobileAccessState,
      config: { ...mobileAccessState.config, interfaceName: "WLAN 2" }
    });
    render(<I18nProvider locale="zh-CN"><MobileAccessSettings /></I18nProvider>);

    const select = await screen.findByLabelText("局域网网卡") as HTMLSelectElement;
    expect(select.value).toBe("WLAN 2");
    expect(screen.getByRole("option", { name: "WLAN 2（不可用，请重新选择）" }).hasAttribute("disabled")).toBe(true);
    const save = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(window.mobileAccessApi.updateConfig).not.toHaveBeenCalled();

    vi.mocked(window.mobileAccessApi.updateConfig).mockResolvedValueOnce(mobileAccessState);
    fireEvent.change(select, { target: { value: "Ethernet" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(window.mobileAccessApi.updateConfig).toHaveBeenCalledWith({ interfaceName: "Ethernet", port: 6174 }));
  });

  it("shows a placeholder and prevents enabling until an adapter is selected", async () => {
    vi.mocked(window.mobileAccessApi.getState).mockResolvedValueOnce({
      ...mobileAccessState,
      config: { ...mobileAccessState.config, enabled: false, interfaceName: "" }
    });
    render(<I18nProvider locale="zh-CN"><MobileAccessSettings /></I18nProvider>);

    const select = await screen.findByLabelText("局域网网卡") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getByRole("option", { name: "请选择局域网网卡" }).hasAttribute("disabled")).toBe(true);
    const enabled = screen.getByRole("checkbox") as HTMLInputElement;
    expect(enabled.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);

    vi.mocked(window.mobileAccessApi.updateConfig).mockResolvedValueOnce(mobileAccessState);
    fireEvent.change(select, { target: { value: "Ethernet" } });
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    await waitFor(() => expect(window.mobileAccessApi.updateConfig).toHaveBeenCalledWith({ enabled: true, interfaceName: "Ethernet", port: 6174 }));
  });

  it("allows disabling access without resubmitting an unavailable adapter", async () => {
    vi.mocked(window.mobileAccessApi.getState).mockResolvedValueOnce({
      ...mobileAccessState,
      config: { ...mobileAccessState.config, interfaceName: "WLAN 2" }
    });
    vi.mocked(window.mobileAccessApi.updateConfig).mockResolvedValueOnce({
      ...mobileAccessState,
      config: { ...mobileAccessState.config, enabled: false, interfaceName: "WLAN 2" }
    });
    render(<I18nProvider locale="zh-CN"><MobileAccessSettings /></I18nProvider>);

    const enabled = await screen.findByRole("checkbox") as HTMLInputElement;
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    await waitFor(() => expect(window.mobileAccessApi.updateConfig).toHaveBeenCalledWith({ enabled: false }));
  });
});
