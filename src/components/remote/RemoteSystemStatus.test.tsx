// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteSystemMetrics } from "../../vite-env";
import { RemoteSystemStatus } from "./RemoteSystemStatus";

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
  it("opens all disks and selects a different mount point", async () => {
    const onSelectDisk = vi.fn();
    const { rerender } = render(
      <RemoteSystemStatus
        state={{ status: "ready", metrics }}
        onSelectDisk={onSelectDisk}
      />
    );

    const trigger = screen.getByRole("button", { name: /当前为 \/data/ });
    expect(screen.getByTitle("CPU：当前利用率 42%").textContent).toContain("CPU 42%");
    expect(trigger.textContent).toContain("/data 80% · I/O 12%");
    expect(trigger.title).toContain("读 3.00 MB/s，写 512 KB/s");
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "全部磁盘目录" })).not.toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByRole("option", { name: /\/dev\/sdb1/ }).textContent).toContain("I/O 忙碌 12%");

    fireEvent.click(screen.getByRole("option", { name: /\/dev\/sda1/ }));
    expect(onSelectDisk).toHaveBeenCalledWith("/");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    rerender(
      <RemoteSystemStatus
        state={{ status: "ready", metrics }}
        preferredDiskMountPoint="/"
        onSelectDisk={onSelectDisk}
      />
    );
    expect(screen.getByRole("button", { name: /当前为 \/$/ }).textContent).toContain("/ 70% · I/O --");
  });

  it("falls back to the highest-use disk while retaining an unavailable preference", () => {
    render(
      <RemoteSystemStatus
        state={{ status: "ready", metrics }}
        preferredDiskMountPoint="/offline"
        onSelectDisk={() => undefined}
      />
    );
    expect(screen.getByRole("button", { name: /当前为 \/data/ }).textContent).toContain("/data 80%");
  });

  it("closes the disk list on Escape and hides it when metrics become empty", async () => {
    const { rerender } = render(
      <RemoteSystemStatus state={{ status: "ready", metrics }} onSelectDisk={() => undefined} />
    );
    const trigger = screen.getByRole("button", { name: /当前为 \/data/ });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    rerender(
      <RemoteSystemStatus
        state={{ status: "ready", metrics: { ...metrics, disks: [] } }}
        onSelectDisk={() => undefined}
      />
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByRole("button", { name: "未找到磁盘指标" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
