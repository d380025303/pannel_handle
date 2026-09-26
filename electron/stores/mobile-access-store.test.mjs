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
  it("persists configuration without storing the plaintext password", () => {
    const store = fixture();
    store.setPassword("strong-password");
    store.updateConfig({ enabled: true, interfaceName: "Wi-Fi", port: 43123 });
    expect(store.getConfig()).toEqual({ enabled: true, interfaceName: "Wi-Fi", port: 43123, hasPassword: true });
    expect(store.verifyPassword("strong-password")).toBe(true);
    expect(store.verifyPassword("wrong-password")).toBe(false);
    expect(fs.readFileSync(path.join(roots.at(-1), "mobile.json"), "utf8")).not.toContain("strong-password");
  });

  it("requires a password to enable access and replaces the old password", () => {
    const store = fixture();
    expect(() => store.updateConfig({ enabled: true })).toThrow("请先设置");
    store.setPassword("first-password");
    store.setPassword("second-password");
    expect(store.verifyPassword("first-password")).toBe(false);
    expect(store.verifyPassword("second-password")).toBe(true);
  });

  it("disables legacy access and clears devices from the old pairing scheme", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-access-legacy-"));
    roots.push(root);
    const accessFile = path.join(root, "mobile.json");
    fs.writeFileSync(accessFile, JSON.stringify({ schemaVersion: 1,
      config: { enabled: true, interfaceName: "Wi-Fi", port: 43123 },
      devices: [{ id: "old-phone", encryptedToken: "old-token" }], audit: [] }));
    const store = createMobileAccessStore({ accessFile });
    store.load();
    expect(store.getConfig()).toMatchObject({ enabled: false, hasPassword: false });
    expect(fs.readFileSync(accessFile, "utf8")).not.toContain("old-token");
  });

  it("rejects an invalid password", () => {
    const store = fixture();
    store.setPassword("strong-password");
    expect(store.verifyPassword("wrong-password")).toBe(false);
  });

  it("retains at most 1000 recent audit entries", () => {
    let now = Date.now();
    const store = fixture(() => now++);
    for (let index = 0; index < 1005; index += 1) store.recordAudit("connection.accepted", { index });
    expect(store.listAudit()).toHaveLength(1000);
  });
});
