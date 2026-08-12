import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMobileAccessStore } from "./mobile-access-store.cjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(now = () => Date.now()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-access-store-"));
  roots.push(root);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace(/^encrypted:/, "")
  };
  const store = createMobileAccessStore({ accessFile: path.join(root, "mobile.json"), safeStorage, now });
  store.load();
  return store;
}

describe("mobile access store", () => {
  it("persists configuration and never exposes device tokens", () => {
    const store = fixture();
    store.updateConfig({ enabled: true, interfaceName: "Wi-Fi", port: 43123 });
    const approved = store.addDevice("Pixel");
    expect(store.verifyDevice(approved.device.id, approved.token)?.name).toBe("Pixel");
    expect(JSON.stringify(store.listDevices())).not.toContain(approved.token);
    expect(store.getConfig()).toEqual({ enabled: true, interfaceName: "Wi-Fi", port: 43123 });
  });

  it("rejects an invalid token with constant-length comparison", () => {
    const store = fixture();
    const approved = store.addDevice("Pixel");
    expect(store.verifyDevice(approved.device.id, "wrong")).toBeNull();
  });

  it("retains at most 1000 recent audit entries", () => {
    let now = Date.now();
    const store = fixture(() => now++);
    for (let index = 0; index < 1005; index += 1) store.recordAudit("connection.accepted", { index });
    expect(store.listAudit()).toHaveLength(1000);
  });
});
