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
__PANNEL_HANDLE_SECTION__ disk
Filesystem Type 1024-blocks Used Available Capacity Mounted on
/dev/sda1 ext4 100000 70000 30000 70% /
tmpfs tmpfs 1000 900 100 90% /run
overlay overlay 100000 95000 5000 95% /container
/dev/sdb1 xfs 200000 160000 40000 80% /data
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
  it("parses Linux network, memory, and highest-use real disk metrics", () => {
    expect(parseLinuxMetrics(SAMPLE)).toEqual({
      network: { receivedBytes: 3000, transmittedBytes: 1200 },
      memory: { totalBytes: 10240000, usedBytes: 6144000 },
      disk: expect.objectContaining({
        filesystem: "/dev/sdb1",
        mountPoint: "/data",
        usedPercent: 80,
        availableBytes: 40960000
      })
    });
  });

  it("reuses a connection and calculates network rates between samples", async () => {
    const client = createClient([
      SAMPLE,
      SAMPLE.replace("eth0: 1000", "eth0: 4000").replace("0 500 0", "0 3500 0")
    ]);
    const times = [1000, 4000];
    const service = createRemoteSystemService({
      terminalManager: { getSession: () => ({ type: "ssh", sshConfig: { host: "example.com" } }) },
      sessionStore: {},
      clientFactory: () => client,
      now: () => times.shift()
    });

    await expect(service.getMetrics("run-1")).resolves.toMatchObject({
      network: { receivedBytesPerSecond: null, transmittedBytesPerSecond: null }
    });
    await expect(service.getMetrics("run-1")).resolves.toMatchObject({
      network: { receivedBytesPerSecond: 1000, transmittedBytesPerSecond: 1000 }
    });
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.exec).toHaveBeenCalledTimes(2);
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
