const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

function unavailable() {
  return Object.assign(new Error("Cannot read Qoder desktop device identity. Please open Qoder and complete device verification."),
    { code: "device-identity-unavailable", retryable: false });
}

function findResources({ run = execFileSync, exists = fs.existsSync, readJson = file => JSON.parse(fs.readFileSync(file, "utf8")) } = {}) {
  const script = 'Get-Process Qoder -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique';
  let running = [];
  try {
    running = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 65536, stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/);
  } catch { /* Try the standard installation locations below. */ }
  let installed = [];
  try {
    const registryScript = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $roots=@("HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*","HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*","HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*"); Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match "^Qoder(?: |$)" } | ForEach-Object { if ($_.InstallLocation) { $_.InstallLocation }; if ($_.DisplayIcon) { $_.DisplayIcon } }';
    installed = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", registryScript],
      { encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 65536, stdio: ["ignore", "pipe", "ignore"] })
      .trim().split(/\r?\n/).filter(Boolean).map(value => {
        const file = value.trim().replace(/,\s*-?\d+$/, "").replace(/^"|"$/g, "");
        return path.join(/\.(?:exe|ico)$/i.test(file) ? path.dirname(file) : file, "resources");
      });
  } catch { /* The installation may not have a registry entry. */ }
  const candidates = [...running.filter(Boolean).map(file => path.join(path.dirname(file), "resources")), ...installed,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Qoder", "resources"),
    path.join(process.env.ProgramFiles || "", "Qoder", "resources")];
  for (const resources of new Set(candidates)) {
    try {
      if (readJson(path.join(resources, "product.json")).productId === "qoder"
        && exists(path.join(resources, "umid", "runtime-info.exe"))) return resources;
    } catch { /* Continue looking for the installed desktop client. */ }
  }
  throw unavailable();
}

function headerValue(value) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 4096
    || !/^[\x20-\x7e]+$/.test(value.trim())) throw unavailable();
  return value.trim();
}

function createDeviceContextReader({ root = path.join(process.env.APPDATA || "", "com.qoder.app.stable"),
  resolveResources = findResources, run = execFileSync, now = Date.now } = {}) {
  let cache;
  return function getRequestHeaders(credentials) {
    if (cache?.accountId === credentials.accountId && cache.expiresAt > now()) return { ...cache.headers };
    try {
      const resources = resolveResources();
      const manifest = JSON.parse(fs.readFileSync(path.join(resources, "build-manifest.json"), "utf8"));
      const identity = JSON.parse(run(path.join(resources, "umid", "runtime-info.exe"), ["3", "--account-stdin"], {
        input: `${JSON.stringify({ account: credentials.accountId })}\n`, encoding: "utf8", windowsHide: true,
        timeout: 25000, maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "ignore"]
      }).trim());
      const headers = {
        "Cosy-Version": headerValue(manifest.productVersion),
        "Cosy-MachineOS": `${process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch}_win32`,
        "Cosy-MachineId": headerValue(fs.readFileSync(path.join(root, "auth.machine-id"), "utf8")),
        "Cosy-MachineToken": headerValue(identity.machineToken),
        "Cosy-MachineCode": headerValue(identity.machineCode),
        "Cosy-MachineType": headerValue(identity.machineType)
      };
      const hostname = os.hostname().trim();
      if (hostname && /^[\x20-\x7e]+$/.test(hostname)) headers["Cosy-MachineHostname"] = hostname.slice(0, 96);
      cache = { accountId: credentials.accountId, expiresAt: now() + 300000, headers };
      return { ...headers };
    } catch { throw unavailable(); }
  };
}

module.exports = { createDeviceContextReader, findResources };
