// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteSystemMetrics } from "../../vite-env";
import { RemoteSystemStatus } from "./RemoteSystemStatus";

const metrics: RemoteSystemMetrics = {
  sampledAt: 1,
  network: { receivedBytesPerSecond: 1024, transmittedBytesPerSecond: 2048 },
  memory: { usedBytes: 4 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 },
  disks: [
    {
      filesystem: "/dev/sdb1",
      type: "xfs",
      mountPoint: "/data",
      usedBytes: 80 * 1024 ** 3,
      totalBytes: 100 * 1024 ** 3,
      availableBytes: 20 * 1024 ** 3,
      usedPercent: 80
    },
    {
      filesystem: "/dev/sda1",
      type: "ext4",
      mountPoint: "/",
      usedBytes: 35 * 1024 ** 3,
      totalBytes: 50 * 1024 ** 3,
      availableBytes: 15 * 1024 ** 3,
      usedPercent: 70
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
    expect(trigger.textContent).toContain("/data 80%");
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "全部磁盘目录" })).not.toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(2);

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
    expect(screen.getByRole("button", { name: /当前为 \/$/ }).textContent).toContain("/ 70%");
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
