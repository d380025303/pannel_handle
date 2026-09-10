// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteSystemMetrics } from "../../vite-env";
import { I18nProvider } from "../../i18n";
import { RemoteSystemStatus } from "./RemoteSystemStatus";
import { RemoteSystemPanel } from "./RemoteSystemPanel";

const metrics: RemoteSystemMetrics = {
  sampledAt: 1,
  network: { receivedBytesPerSecond: 1024, transmittedBytesPerSecond: 2048 },
  memory: { usedBytes: 4 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 },
  cpu: { usedPercent: 42.4 },
  disks: [
    {
      filesystem: "/dev/sdb1",
      type: "xfs",
      mountPoint: "/data",
      usedBytes: 80 * 1024 ** 3,
      totalBytes: 100 * 1024 ** 3,
      availableBytes: 20 * 1024 ** 3,
      usedPercent: 80,
      io: {
        busyPercent: 12.4,
        readBytesPerSecond: 3 * 1024 ** 2,
        writeBytesPerSecond: 512 * 1024
      }
    },
    {
      filesystem: "/dev/sda1",
      type: "ext4",
      mountPoint: "/",
      usedBytes: 35 * 1024 ** 3,
      totalBytes: 50 * 1024 ** 3,
      availableBytes: 15 * 1024 ** 3,
      usedPercent: 70,
      io: { busyPercent: null, readBytesPerSecond: null, writeBytesPerSecond: null }
    }
  ]
};

afterEach(cleanup);

describe("RemoteSystemStatus", () => {
  it("keeps only an accessible monitor entry and opens on click", () => {
    const onOpen = vi.fn();
    const { rerender } = render(<RemoteSystemStatus state={{ status: "ready", metrics }} active={false} onOpen={onOpen} />);
    const button = screen.getByRole("button", { name: "SSH 服务器指标" });
    expect(button.textContent).toBe("");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledOnce();
    rerender(<RemoteSystemStatus state={{ status: "error" }} active onOpen={onOpen} />);
    expect(screen.getByRole("button", { name: "服务器监控不可用" }).getAttribute("aria-pressed")).toBe("true");
    rerender(<RemoteSystemStatus state={{ status: "loading" }} active={false} onOpen={onOpen} />);
    expect(screen.getByRole("button", { name: "正在读取服务器状态..." })).not.toBeNull();
    rerender(<RemoteSystemStatus state={{ status: "hidden" }} active={false} onOpen={onOpen} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("RemoteSystemPanel", () => {
  it("shows all metrics and selects a different mount point", () => {
    const onSelectDisk = vi.fn();
    const props = { state: { status: "ready" as const, metrics }, sessionTitle: "SSH demo", onSelectDisk };
    const { rerender } = render(<RemoteSystemPanel {...props} />);
    expect(screen.getByText("SSH demo")).not.toBeNull();
    expect(screen.getByRole("progressbar", { name: "CPU" }).getAttribute("value")).toBe("42.4");
    expect(screen.getByText("↓ 1.00 KB/s")).not.toBeNull();
    expect(screen.getByText("↑ 2.00 KB/s")).not.toBeNull();
    expect(screen.getByText("3.00 MB/s")).not.toBeNull();
    const select = screen.getByRole("combobox", { name: /当前为 \/data/ });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.change(select, { target: { value: "/" } });
    expect(onSelectDisk).toHaveBeenCalledWith("/");
    rerender(<RemoteSystemPanel {...props} preferredDiskMountPoint="/" />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("/");
    expect(within(screen.getByRole("region", { name: "磁盘" })).getAllByText("--")).toHaveLength(3);
  });

  it("falls back to the first disk without overwriting a missing preference", () => {
    const onSelectDisk = vi.fn();
    render(<RemoteSystemPanel state={{ status: "ready", metrics }} sessionTitle="SSH" preferredDiskMountPoint="/offline" onSelectDisk={onSelectDisk} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("/data");
    expect(onSelectDisk).not.toHaveBeenCalled();
  });

  it("handles missing metrics without displaying fabricated zero usage", () => {
    const unknown = { ...metrics, disks: [], cpu: { usedPercent: null }, memory: { usedBytes: 0, totalBytes: 0 }, network: { receivedBytesPerSecond: null, transmittedBytesPerSecond: null } };
    render(<RemoteSystemPanel state={{ status: "ready", metrics: unknown }} sessionTitle="SSH" onSelectDisk={vi.fn()} />);
    expect((screen.getByRole("combobox", { name: "未找到磁盘指标" }) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("↓ --")).not.toBeNull();
    expect(screen.getByText("↑ --")).not.toBeNull();
  });

  it("clears old values in loading and error states and supports English", () => {
    const props = { sessionTitle: "SSH", onSelectDisk: vi.fn() };
    const { rerender } = render(<RemoteSystemPanel {...props} state={{ status: "ready", metrics }} />);
    rerender(<RemoteSystemPanel {...props} state={{ status: "loading" }} />);
    expect(screen.getByRole("status").textContent).toBe("正在读取服务器状态...");
    expect(screen.queryByRole("progressbar")).toBeNull();
    rerender(<I18nProvider locale="en-US"><RemoteSystemPanel {...props} state={{ status: "error" }} /></I18nProvider>);
    expect(screen.getByRole("status").textContent).toBe("Server monitoring is unavailable");
    rerender(<RemoteSystemPanel {...props} state={{ status: "hidden" }} />);
    expect(screen.queryByRole("region")).toBeNull();
  });
});
