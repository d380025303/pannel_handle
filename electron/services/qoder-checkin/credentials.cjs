const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

function unprotectWindows(data) {
  if (process.platform !== "win32") throw new Error("Windows is required.");
  const script = "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $k=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($k))";
  return Buffer.from(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: data.toString("base64"), encoding: "utf8", windowsHide: true,
    timeout: 10000, maxBuffer: 8192, stdio: ["pipe", "pipe", "ignore"]
  }).trim(), "base64");
}

function readCredentials({ root = path.join(process.env.APPDATA || "", "com.qoder.app.stable"), unprotect = unprotectWindows } = {}) {
  if (!fs.existsSync(path.join(root, "auth.v1.dat"))) throw Object.assign(new Error("Qoder desktop App is not installed or signed in."), { retryable: false });
  let key;
  let plain;
  try {
    const encryptedKey = Buffer.from(JSON.parse(fs.readFileSync(path.join(root, "Local State"), "utf8")).os_crypt.encrypted_key, "base64");
    if (encryptedKey.subarray(0, 5).toString() !== "DPAPI") throw new Error();
    key = unprotect(encryptedKey.subarray(5));
    const data = fs.readFileSync(path.join(root, "auth.v1.dat"));
    if (data.subarray(0, 3).toString() !== "v10") throw new Error();
    const cipher = crypto.createDecipheriv("aes-256-gcm", key, data.subarray(3, 15));
    cipher.setAuthTag(data.subarray(-16));
    plain = Buffer.concat([cipher.update(data.subarray(15, -16)), cipher.final()]);
    const auth = JSON.parse(plain.toString("utf8"));
    if (typeof auth.token !== "string" || !auth.token || typeof auth.user?.id !== "string" || !auth.user.id || !Number.isFinite(Date.parse(auth.expiresAt))) throw new Error();
    if (Date.parse(auth.expiresAt) <= Date.now()) throw new Error("expired");
    const label = [auth.user.email, auth.user.name, auth.user.id].find(value => typeof value === "string" && value.trim());
    return { token: auth.token, accountId: auth.user.id, accountLabel: label.slice(0, 240) };
  } catch (error) {
    throw Object.assign(new Error(error.message === "expired" ? "Qoder desktop login expired. Please sign in again." : "Cannot read Qoder desktop login. Please sign in to the desktop App again."), { retryable: false });
  } finally {
    key?.fill(0);
    plain?.fill(0);
  }
}

module.exports = { readCredentials };
