import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, it, expect } from "vitest";
const require = createRequire(import.meta.url);
const { readCredentials } = require("./credentials.cjs");
const dirs = [];
afterEach(() => { for (const root of dirs.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(expiresAt = "2099-01-01T00:00:00Z") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-checkin-")); dirs.push(root);
  const key = crypto.randomBytes(32), nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify({ token: "test-secret", user: { id: "desktop", email: "desktop@example.test" }, expiresAt })), cipher.final()]);
  fs.writeFileSync(path.join(root, "auth.v1.dat"), Buffer.concat([Buffer.from("v10"), nonce, body, cipher.getAuthTag()]));
  fs.writeFileSync(path.join(root, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from("DPAPIciphertext").toString("base64") } }));
  return { root, unprotect: () => Buffer.from(key) };
}
describe("Qoder desktop credentials", () => {
  it("decrypts the desktop format without modifying the source", () => {
    const options = fixture(); const before = fs.readFileSync(path.join(options.root, "auth.v1.dat"));
    expect(readCredentials(options)).toMatchObject({ accountId: "desktop", token: "test-secret", accountLabel: "desktop@example.test" });
    expect(fs.readFileSync(path.join(options.root, "auth.v1.dat"))).toEqual(before);
  });
  it("reports expired, corrupted and missing login without leaking credentials", () => {
    expect(() => readCredentials(fixture("2000-01-01T00:00:00Z"))).toThrow("expired");
    const options = fixture(); fs.writeFileSync(path.join(options.root, "auth.v1.dat"), "test-secret");
    expect(() => readCredentials(options)).toThrow("Cannot read Qoder");
    fs.unlinkSync(path.join(options.root, "auth.v1.dat"));
    expect(() => readCredentials(options)).toThrow("not installed or signed in");
  });
  it("supports safeStorage payloads while retaining Qoder's own v10 key", () => {
    const options = fixture();
    const encrypted = Buffer.from("native-storage-payload");
    fs.writeFileSync(path.join(options.root, "auth.v1.dat"), encrypted);
    const plain = Buffer.from(JSON.stringify({ token: "test-secret", user: { id: "desktop" }, expiresAt: "2099-01-01T00:00:00Z" }));
    expect(readCredentials({ ...options, decrypt: data => {
      expect(data).toEqual(encrypted);
      return plain;
    } })).toMatchObject({ accountId: "desktop", accountLabel: "desktop" });
    expect(plain.every(value => value === 0)).toBe(true);
    expect(fs.readFileSync(path.join(options.root, "auth.v1.dat"))).toEqual(encrypted);
  });
});
