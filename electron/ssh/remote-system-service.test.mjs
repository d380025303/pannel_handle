import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createRemoteSystemService, parseLinuxMetrics } = require("./remote-system-service.cjs");

const SAMPLE = `__PANNEL_HANDLE_SECTION__ network
Inter-|   Receive                                                |  Transmit
 face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed
    lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0
  eth0: 1000 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0
 wlan0: 2000 0 0 0 0 0 0 0 700 0 0 0 0 0 0 0
__PANNEL_HANDLE_SECTION__ memory
MemTotal:       10000 kB
MemFree:         1000 kB
MemAvailable:    4000 kB
__PANNEL_HANDLE_SECTION__ cpu
cpu  100 0 50 850 0 0 0 0 0 0
__PANNEL_HANDLE_SECTION__ disk
Filesystem Type 1024-blocks Used Available Capacity Mounted on
/dev/sda1 ext4 100000 70000 30000 70% /
tmpfs tmpfs 1000 900 100 90% /run
overlay overlay 100000 95000 5000 95% /container
/dev/sdb1 xfs 200000 160000 40000 80% /data
__PANNEL_HANDLE_SECTION__ mountinfo
36 25 8:1 / / rw,relatime - ext4 /dev/sda1 rw
37 25 8:17 / /data rw,relatime - xfs /dev/sdb1 rw
__PANNEL_HANDLE_SECTION__ diskio
8 1 sda1 10 0 100 10 20 0 200 20 0 1000 0
8 17 sdb1 30 0 300 30 40 0 400 40 0 2000 0
`;

function createClient(outputs) {
  const client = new EventEmitter();
  client.connect = vi.fn(() => queueMicrotask(() => client.emit("ready")));
  client.end = vi.fn();
  client.exec = vi.fn((_command, callback) => {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    callback(undefined, stream);
    queueMicrotask(() => {
      stream.emit("data", outputs.shift());
      stream.emit("close", 0);
    });
  });
  return client;
}

describe("remote-system-service", () => {
  it("parses Linux CPU, network, memory, mount, and disk metrics", () => {
    expect(parseLinuxMetrics(SAMPLE)).toEqual({
      network: { receivedBytes: 3000, transmittedBytes: 1200 },
      memory: { totalBytes: 10240000, usedBytes: 6144000 },
      cpu: { totalTicks: 1000, idleTicks: 850 },
      disks: [
        expect.objectContaining({
          filesystem: "/dev/sdb1",
          mountPoint: "/data",
          usedPercent: 80,
          availableBytes: 40960000
        }),
        expect.objectContaining({
          filesystem: "/dev/sda1",
          mountPoint: "/",
          usedPercent: 70
        })
      ],
      mountDevices: { "/": "8:1", "/data": "8:17" },
      diskIo: {
        "8:1": {
          device: "sda1",
          readSectors: 100,
          writeSectors: 200,
          busyMilliseconds: 1000
        },
        "8:17": {
          device: "sdb1",
          readSectors: 300,
          writeSectors: 400,
          busyMilliseconds: 2000
        }
      }
    });
  });

  it("reuses a connection and calculates CPU, network, and per-mount disk rates", async () => {
    const client = createClient([
      SAMPLE,
      SAMPLE
        .replace("eth0: 1000", "eth0: 4000")
        .replace("0 500 0", "0 3500 0")
        .replace("cpu  100 0 50 850", "cpu  160 0 80 960")
        .replace("8 1 sda1 10 0 100 10 20 0 200 20 0 1000 0", "8 1 sda1 10 0 130 10 20 0 260 20 0 1300 0")
    ]);
    const times = [1000, 4000];
    const service = createRemoteSystemService({
      terminalManager: { getSession: () => ({ type: "ssh", sshConfig: { host: "example.com" } }) },
      sessionStore: {},
      clientFactory: () => client,
      now: () => times.shift()
    });

    await expect(service.getMetrics("run-1")).resolves.toMatchObject({
      network: { receivedBytesPerSecond: null, transmittedBytesPerSecond: null },
      cpu: { usedPercent: null },
      disks: [
        { mountPoint: "/data", io: { busyPercent: null, readBytesPerSecond: null, writeBytesPerSecond: null } },
        { mountPoint: "/", io: { busyPercent: null, readBytesPerSecond: null, writeBytesPerSecond: null } }
      ]
    });
    await expect(service.getMetrics("run-1")).resolves.toMatchObject({
      network: { receivedBytesPerSecond: 1000, transmittedBytesPerSecond: 1000 },
      cpu: { usedPercent: 45 },
      disks: [
        { mountPoint: "/data", io: { busyPercent: 0, readBytesPerSecond: 0, writeBytesPerSecond: 0 } },
        { mountPoint: "/", io: { busyPercent: 10, readBytesPerSecond: 5120, writeBytesPerSecond: 10240 } }
      ]
    });
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.exec).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable deltas when counters reset or a mount has no block device", async () => {
    const networkDisk = SAMPLE
      .replace("/dev/sdb1 xfs 200000 160000 40000 80% /data", "server:/data nfs 200000 160000 40000 80% /data")
      .replace("37 25 8:17 / /data rw,relatime - xfs /dev/sdb1 rw\n", "");
    const reset = networkDisk
      .replace("eth0: 1000", "eth0: 100")
      .replace("cpu  100 0 50 850", "cpu  10 0 5 85")
      .replace("8 1 sda1 10 0 100 10 20 0 200 20 0 1000 0", "8 1 sda1 10 0 10 10 20 0 20 20 0 100 0");
    const client = createClient([networkDisk, reset]);
    const times = [1000, 4000];
    const service = createRemoteSystemService({
      terminalManager: { getSession: () => ({ type: "ssh", sshConfig: { host: "example.com" } }) },
      sessionStore: {},
      clientFactory: () => client,
      now: () => times.shift()
    });

    await service.getMetrics("run-1");
    await expect(service.getMetrics("run-1")).resolves.toMatchObject({
      network: { receivedBytesPerSecond: null },
      cpu: { usedPercent: null },
      disks: [
        { mountPoint: "/data", io: { busyPercent: null, readBytesPerSecond: null, writeBytesPerSecond: null } },
        { mountPoint: "/", io: { busyPercent: null, readBytesPerSecond: null, writeBytesPerSecond: null } }
      ]
    });
  });

  it("rejects non-SSH sessions and closes cached clients", async () => {
    const nonSshService = createRemoteSystemService({
      terminalManager: { getSession: () => ({ type: "windows" }) },
      sessionStore: {}
    });
    await expect(nonSshService.getMetrics("run-1")).rejects.toThrow("only available for SSH");

    const client = createClient([SAMPLE]);
    const service = createRemoteSystemService({
      terminalManager: { getSession: () => ({ type: "ssh", sshConfig: { host: "example.com" } }) },
      sessionStore: {},
      clientFactory: () => client
    });
    await service.getMetrics("run-1");
    await service.disconnect("run-1");
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});
