import { createRequire } from "node:module";
import { describe, it, expect, vi } from "vitest";
const require = createRequire(import.meta.url);
const { registerQoderCheckinIpcHandlers } = require("./ipc.cjs");

describe("Qoder check-in IPC", () => {
  it("passes only the expected account and serializes controlled errors without Electron prefixes or secrets", async () => {
    const handlers = new Map();
    const service = { getStatus: vi.fn(async () => ({ accountId: "account", todayCheckedIn: true })),
      claim: vi.fn(async () => { throw Object.assign(Error("private-device-token"), { code: "device-identity-unavailable" }); }) };
    registerQoderCheckinIpcHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, service });
    expect(await handlers.get("qoder-checkin:get-status")({}, { accountId: "account" }))
      .toMatchObject({ ok: true, value: { todayCheckedIn: true } });
    expect(service.getStatus).toHaveBeenCalledWith("account");
    const failed = await handlers.get("qoder-checkin:claim")({}, { accountId: "account" });
    expect(failed).toMatchObject({ ok: false, error: { code: "device-identity-unavailable", message: expect.stringContaining("设备身份") } });
    expect(JSON.stringify(failed)).not.toMatch(/private-device-token|Error invoking/);
    expect(await handlers.get("qoder-checkin:claim")({}, { accountId: { token: "secret" } }))
      .toMatchObject({ ok: false, error: { code: "invalid-account" } });
    expect(service.claim).toHaveBeenCalledTimes(1);
  });
});
