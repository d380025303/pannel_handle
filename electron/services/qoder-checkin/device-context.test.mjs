import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createDeviceContextReader } = require("./device-context.cjs");
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-device-")); dirs.push(root);
  fs.writeFileSync(path.join(root, "auth.machine-id"), "test-machine-id\n");
  fs.writeFileSync(path.join(root, "build-manifest.json"), JSON.stringify({ productVersion: "0.4.3" }));
  const run = vi.fn(() => JSON.stringify({ machineToken: "test-device-token", machineCode: "test-code", machineType: "test-type" }));
  let clock = 0;
  return { root, run, advance: () => { clock += 300001; },
    read: createDeviceContextReader({ root, resolveResources: () => root, run, now: () => clock }) };
}
describe("Qoder desktop device context", () => {
  it("uses official helper input and caches only for the same account and five minutes", () => {
    const f = fixture();
    expect(f.read({ accountId: "account" })).toMatchObject({ "Cosy-Version": "0.4.3", "Cosy-MachineId": "test-machine-id", "Cosy-MachineToken": "test-device-token" });
    expect(f.run.mock.calls[0][1]).toEqual(["3", "--account-stdin"]);
    expect(JSON.parse(f.run.mock.calls[0][2].input)).toEqual({ account: "account" });
    f.read({ accountId: "account" }); expect(f.run).toHaveBeenCalledTimes(1);
    f.read({ accountId: "other" }); expect(f.run).toHaveBeenCalledTimes(2);
    f.advance(); f.read({ accountId: "other" }); expect(f.run).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(path.join(f.root, "auth.machine-id"), "utf8")).toBe("test-machine-id\n");
  });
  it("reports missing or malformed identity without disclosing helper output", () => {
    const f = fixture();
    f.run.mockImplementation(() => { throw Error("private-device-secret"); });
    expect(() => f.read({ accountId: "account" })).toThrow("complete device verification");
    f.run.mockReturnValue(JSON.stringify({ machineToken: "secret\r\nheader", machineCode: "code", machineType: "type" }));
    expect(() => f.read({ accountId: "account" })).toThrow("device identity");
    fs.unlinkSync(path.join(f.root, "auth.machine-id"));
    expect(() => f.read({ accountId: "account" })).toThrow("device identity");
  });
});
