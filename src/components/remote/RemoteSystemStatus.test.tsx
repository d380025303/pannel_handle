// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteSystemMetrics } from "../../vite-env";
import { I18nProvider } from "../../i18n";
import { RemoteSystemStatus } from "./RemoteSystemStatus";
import { RemoteSystemPanel } from "./RemoteSystemPanel";
import { RemoteMetricChart, RemoteNetworkChart } from "./RemoteMetricChart";

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
const history = [
  { sampledAt: 1000, cpuUsedPercent: 35, memoryUsedPercent: 45, receivedBytesPerSecond: 512, transmittedBytesPerSecond: 256 },
  { sampledAt: 4000, cpuUsedPercent: 42.4, memoryUsedPercent: 50, receivedBytesPerSecond: 1024, transmittedBytesPerSecond: 2048 }
];

afterEach(cleanup);

describe("RemoteSystemStatus", () => {
  it("keeps only an accessible monitor entry and opens on click", () => {
    const onOpen = vi.fn();
    const { rerender } = render(<RemoteSystemStatus state={{ status: "ready", metrics, history }} active={false} onOpen={onOpen} />);
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
    const props = { state: { status: "ready" as const, metrics, history }, sessionTitle: "SSH demo", onSelectDisk };
    const { rerender } = render(<RemoteSystemPanel {...props} />);
    expect(screen.getByText("SSH demo")).not.toBeNull();
    expect(screen.getByRole("img", { name: "CPU 最近 5 分钟利用率，当前 42.4%" })).not.toBeNull();
    expect(screen.getByRole("img", { name: "内存 最近 5 分钟利用率，当前 50%" })).not.toBeNull();
    expect(screen.getByRole("img", { name: "网络最近 5 分钟速率，当前下载 1 KB/s，上传 2 KB/s" })).not.toBeNull();
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
    render(<RemoteSystemPanel state={{ status: "ready", metrics, history }} sessionTitle="SSH" preferredDiskMountPoint="/offline" onSelectDisk={onSelectDisk} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("/data");
    expect(onSelectDisk).not.toHaveBeenCalled();
  });

  it("handles missing metrics without displaying fabricated zero usage", () => {
    const unknown = { ...metrics, disks: [], cpu: { usedPercent: null }, memory: { usedBytes: 0, totalBytes: 0 }, network: { receivedBytesPerSecond: null, transmittedBytesPerSecond: null } };
    render(<RemoteSystemPanel state={{ status: "ready", metrics: unknown, history: [] }} sessionTitle="SSH" onSelectDisk={vi.fn()} />);
    expect((screen.getByRole("combobox", { name: "未找到磁盘指标" }) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("↓ --")).not.toBeNull();
    expect(screen.getByText("↑ --")).not.toBeNull();
  });

  it("clears old values in loading and error states and supports English", () => {
    const props = { sessionTitle: "SSH", onSelectDisk: vi.fn() };
    const { rerender } = render(<RemoteSystemPanel {...props} state={{ status: "ready", metrics, history }} />);
    rerender(<RemoteSystemPanel {...props} state={{ status: "loading" }} />);
    expect(screen.getByRole("status").textContent).toBe("正在读取服务器状态...");
    expect(screen.queryByRole("progressbar")).toBeNull();
    rerender(<I18nProvider locale="en-US"><RemoteSystemPanel {...props} state={{ status: "error" }} /></I18nProvider>);
    expect(screen.getByRole("status").textContent).toBe("Server monitoring is unavailable");
    rerender(<RemoteSystemPanel {...props} state={{ status: "hidden" }} />);
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("breaks chart lines across missing sampling intervals", () => {
    const chartHistory = [
      { sampledAt: 1000, cpuUsedPercent: 10, memoryUsedPercent: 20, receivedBytesPerSecond: 100, transmittedBytesPerSecond: 50 },
      { sampledAt: 4000, cpuUsedPercent: 20, memoryUsedPercent: 30, receivedBytesPerSecond: 200, transmittedBytesPerSecond: 100 },
      { sampledAt: 16000, cpuUsedPercent: 30, memoryUsedPercent: 40, receivedBytesPerSecond: 300, transmittedBytesPerSecond: 150 },
      { sampledAt: 19000, cpuUsedPercent: 40, memoryUsedPercent: 50, receivedBytesPerSecond: 400, transmittedBytesPerSecond: 200 }
    ];
    const { container } = render(<RemoteMetricChart
      points={chartHistory}
      metric="CPU"
      currentValue={40}
      getValue={(point) => point.cpuUsedPercent}
      tone="cpu"
    />);
    expect(container.querySelectorAll("polyline")).toHaveLength(2);
  });

  it("connects regular slow SSH samples in metric and network charts", () => {
    const slowHistory = [0, 20000, 40000, 60000].map((sampledAt, index) => ({
      sampledAt,
      cpuUsedPercent: 10 + index * 5,
      memoryUsedPercent: 20 + index,
      receivedBytesPerSecond: 100 + index * 10,
      transmittedBytesPerSecond: 50 + index * 10
    }));
    const { container } = render(<>
      <RemoteMetricChart points={slowHistory} metric="CPU" currentValue={25} getValue={(point) => point.cpuUsedPercent} tone="cpu" />
      <RemoteNetworkChart points={slowHistory} received={130} transmitted={80} />
    </>);
    expect(container.querySelectorAll("polyline")).toHaveLength(3);
    expect(container.querySelectorAll("circle.remote-metric-line")).toHaveLength(0);
  });

  it("keeps genuine gaps and missing values disconnected at a slow cadence", () => {
    const slowHistory = [
      { sampledAt: 0, cpuUsedPercent: 10 },
      { sampledAt: 20000, cpuUsedPercent: 15 },
      { sampledAt: 40000, cpuUsedPercent: 20 },
      { sampledAt: 130000, cpuUsedPercent: 25 },
      { sampledAt: 150000, cpuUsedPercent: 30 },
      { sampledAt: 170000, cpuUsedPercent: null },
      { sampledAt: 190000, cpuUsedPercent: 35 }
    ].map((point) => ({ ...point, memoryUsedPercent: null, receivedBytesPerSecond: null, transmittedBytesPerSecond: null }));
    const { container } = render(<RemoteMetricChart
      points={slowHistory} metric="CPU" currentValue={35} getValue={(point) => point.cpuUsedPercent} tone="cpu"
    />);
    expect(container.querySelectorAll("polyline")).toHaveLength(2);
    expect(container.querySelectorAll("circle.remote-metric-line")).toHaveLength(1);
  });

  it("shows exact sampled values while hovering metric and network charts", () => {
    render(<RemoteSystemPanel state={{ status: "ready", metrics, history }} sessionTitle="SSH" onSelectDisk={vi.fn()} />);
    const cpuChart = screen.getByRole("img", { name: /CPU 最近 5 分钟利用率/ });
    vi.spyOn(cpuChart, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 104, width: 320, height: 104, toJSON: () => ({})
    });
    fireEvent.mouseMove(cpuChart, { clientX: 320 });
    expect(screen.getByRole("status").textContent).toContain("CPU 42.4%");
    fireEvent.mouseLeave(cpuChart.closest("figure")!);
    expect(screen.queryByRole("status")).toBeNull();

    const networkChart = screen.getByRole("img", { name: /网络最近 5 分钟速率/ });
    vi.spyOn(networkChart, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 104, width: 320, height: 104, toJSON: () => ({})
    });
    fireEvent.mouseMove(networkChart, { clientX: 320 });
    const tooltip = screen.getByRole("status");
    expect(tooltip.textContent).toContain("↓ 1 KB/s");
    expect(tooltip.textContent).toContain("↑ 2 KB/s");
  });
});
