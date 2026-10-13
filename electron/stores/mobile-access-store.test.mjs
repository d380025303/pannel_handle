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
  it("persists configuration without storing the plaintext password", async () => {
    const store = fixture();
    store.setPassword("strong-password");
    store.updateConfig({ enabled: true, interfaceName: "Wi-Fi", port: 43123 });
    expect(store.getConfig()).toEqual({ enabled: true, interfaceName: "Wi-Fi", port: 43123, hasPassword: true });
    expect(await store.verifyPassword("strong-password")).toBe(true);
    expect(await store.verifyPassword("wrong-password")).toBe(false);
    expect(fs.readFileSync(path.join(roots.at(-1), "mobile.json"), "utf8")).not.toContain("strong-password");
  });

  it("requires a password to enable access and replaces the old password", async () => {
    const store = fixture();
    expect(() => store.updateConfig({ enabled: true })).toThrow("请先设置");
    store.setPassword("first-password");
    store.setPassword("second-password");
    expect(await store.verifyPassword("first-password")).toBe(false);
    expect(await store.verifyPassword("second-password")).toBe(true);
  });

  it("disables legacy access and clears devices from the old pairing scheme", async () => {
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

  it("rejects an invalid password", async () => {
    const store = fixture();
    store.setPassword("strong-password");
    expect(await store.verifyPassword("wrong-password")).toBe(false);
  });

  it("retains at most 1000 recent audit entries", async () => {
    let now = Date.now();
    const store = fixture(() => now++);
    for (let index = 0; index < 1005; index += 1) store.recordAudit("connection.accepted", { index });
    expect(store.listAudit()).toHaveLength(1000);
  });
});

it("keeps timers responsive during five real failed password logins", async () => {
  const { createMobileAuth } = await import("../services/mobile-remote/mobile-auth.cjs");
  const store = fixture();
  store.setPassword("strong-password");
  const sendError = vi.fn();
  const auth = createMobileAuth({ accessStore: store, now: Date.now, sendError,
    sendReady: vi.fn(), releaseDeviceSizes: vi.fn(), broadcastState: vi.fn(),
    currentState: () => ({}), notifyConnection: vi.fn() });
  const socket = { readyState: 1, remoteAddress: "test", close: vi.fn() };
  let completed = false;
  const started = performance.now();
  const attempts = (async () => {
    for (let index = 0; index < 5; index++) await auth.handlePasswordLogin(socket, { password: "wrong-password" });
    completed = true;
  })();
  await new Promise(resolve => setTimeout(resolve, 0));
  const timerDelay = performance.now() - started;
  expect(completed).toBe(false);
  await attempts;
  console.info(`Five password checks: ${(performance.now() - started).toFixed(1)} ms; timer: ${timerDelay.toFixed(1)} ms`);
  expect(sendError.mock.calls.map(call => call[1])).toEqual(Array(5).fill("PASSWORD_INVALID"));
  await auth.handlePasswordLogin(socket, { password: "strong-password" });
  expect(sendError).toHaveBeenLastCalledWith(socket, "AUTH_RATE_LIMIT", expect.any(String));
});

it("rejects an old password check when the password changes during derivation", async () => {
  const store = fixture();
  store.setPassword("first-password");
  const pending = store.verifyPassword("first-password");
  store.setPassword("second-password");
  expect(await pending).toBe(false);
  expect(await store.verifyPassword("second-password")).toBe(true);
});
