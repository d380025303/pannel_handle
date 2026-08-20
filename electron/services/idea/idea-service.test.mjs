import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import bridgeModule from "./idea-service.cjs";

const { createIdeaBridgeService, validateDiscovery } = bridgeModule;
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function discovery(overrides = {}) {
  return {
    protocolVersion: 1,
    bridgeId: "bridge_abcdefghijkl",
    pid: 4242,
    productName: "IntelliJ IDEA",
    productVersion: "2025.2.6.1",
    buildNumber: "252.28539.33",
    port: 32123,
    token: "abcdefghijklmnopqrstuvwxyzABCDEFGH123456",
    updatedAt: Date.now(),
    ...overrides
  };
}

class FakeSocket extends EventEmitter {
  constructor(snapshot) {
    super();
    this.snapshot = snapshot;
    this.destroyed = false;
    this.writes = [];
  }

  setNoDelay() {}
  setTimeout() {}
  write(value) {
    this.writes.push(value);
    const message = JSON.parse(value.trim());
    if (message.type === "auth") {
      queueMicrotask(() => this.emit("data", Buffer.from('{"type":"auth","ok":true,"protocolVersion":1}\n')));
    } else if (message.method === "snapshot") {
      queueMicrotask(() => this.emit("data", Buffer.from(`${JSON.stringify({ type: "response", requestId: message.requestId, ok: true, result: this.snapshot })}\n`)));
    } else {
      queueMicrotask(() => this.emit("data", Buffer.from(`${JSON.stringify({ type: "response", requestId: message.requestId, ok: true, result: { accepted: true } })}\n`)));
    }
    return true;
  }
  destroy() { this.destroyed = true; }
}

async function eventually(check) {
  for (let index = 0; index < 30; index += 1) {
    try { return check(); } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  return check();
}

describe("validateDiscovery", () => {
  it("accepts a current authenticated loopback discovery record", () => {
    expect(validateDiscovery(discovery())).toMatchObject({ bridgeId: "bridge_abcdefghijkl", port: 32123, pid: 4242 });
  });

  it("rejects stale and incompatible records", () => {
    expect(() => validateDiscovery(discovery({ updatedAt: Date.now() - 30_000 }))).toThrow(/stale/i);
    expect(() => validateDiscovery(discovery({ protocolVersion: 2 }))).toThrow(/unsupported/i);
  });
});

describe("createIdeaBridgeService", () => {
  it("discovers, authenticates, snapshots, and dispatches an IDEA operation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "idea-bridge-test-"));
    tempDirs.push(dir);
    const record = discovery();
    await fs.writeFile(path.join(dir, `${record.bridgeId}.json`), JSON.stringify(record));
    const snapshot = {
      protocolVersion: 1,
      bridgeId: record.bridgeId,
      productName: record.productName,
      productVersion: record.productVersion,
      buildNumber: record.buildNumber,
      projects: [{ id: "project-1", name: "Demo", path: "C:\\demo", configurations: [] }]
    };
    const socket = new FakeSocket(snapshot);
    const broadcasts = [];
    const service = createIdeaBridgeService({
      discoveryDir: dir,
      processAlive: () => true,
      connect: () => {
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
      broadcast: (channel, value) => broadcasts.push([channel, value]),
      scanIntervalMs: 60_000
    });
    await service.start();
    await eventually(() => expect(service.getSnapshot().connections[0]).toMatchObject({ status: "connected", projects: [{ name: "Demo" }] }));
    await expect(service.startConfiguration(record.bridgeId, "project-1", "config-1", "run")).resolves.toEqual({ accepted: true });
    expect(socket.writes.some((line) => line.includes('"method":"start"'))).toBe(true);
    expect(broadcasts.some(([channel]) => channel === "idea-bridge:changed")).toBe(true);
    await service.shutdown();
  });
});
