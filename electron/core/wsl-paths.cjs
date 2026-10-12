const path = require("node:path");

function normalizeWslPath(value, fallbackPath = "~") {
  const rawPath = String(value || fallbackPath || "~").trim() || fallbackPath || "~";
  if (rawPath.includes("\0")) {
    throw new Error("Invalid WSL path.");
  }
  if (rawPath === "~") {
    return "~";
  }
  const normalized = rawPath.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!normalized.startsWith("/")) {
    throw new Error("WSL path must be an absolute Linux path.");
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function validateWslDistro(wslDistro) {
  const distro = String(wslDistro || "").trim();
  if (!/^[\w.-]+$/.test(distro)) {
    throw new Error("A valid WSL distro is required.");
  }
  return distro;
}

function toWslHostPath(wslDistro, linuxPath) {
  const distro = validateWslDistro(wslDistro);
  const normalized = normalizeWslPath(linuxPath);
  if (normalized === "~") {
    return path.win32.join(`\\\\wsl.localhost\\${distro}`, "home");
  }
  const mntMatch = normalized.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
  if (mntMatch) {
    let depth = 0;
    for (const segment of (mntMatch[2] || "").split("/")) {
      if (segment === "..") {
        if (depth === 0) {
          throw new Error("WSL path must not traverse above the drive mount root. Use a canonical absolute Linux path.");
        }
        depth -= 1;
      } else if (segment && segment !== ".") {
        depth += 1;
      }
    }
    const drive = mntMatch[1].toUpperCase();
    const rest = mntMatch[2] ? mntMatch[2].replace(/\//g, "\\") : "\\";
    return `${drive}:${rest}`;
  }
  return path.win32.join(`\\\\wsl.localhost\\${distro}`, ...normalized.split("/").filter(Boolean));
}

function fromWslHostPath(hostPath, wslDistro) {
  const distro = validateWslDistro(wslDistro);
  const normalizedHostPath = String(hostPath || "").replace(/\//g, "\\");
  const winDriveMatch = normalizedHostPath.match(/^([a-zA-Z]):(.*)$/);
  if (winDriveMatch) {
    const drive = winDriveMatch[1].toLowerCase();
    const rest = winDriveMatch[2] ? winDriveMatch[2].replace(/\\/g, "/") : "";
    return normalizeWslPath(`/mnt/${drive}${rest}`);
  }
  const prefix = `\\\\wsl.localhost\\${distro}`;
  if (!normalizedHostPath.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normalizeWslPath(hostPath);
  }
  const rest = normalizedHostPath.slice(prefix.length).replace(/\\/g, "/");
  return rest ? normalizeWslPath(rest) : "/";
}

function joinWslPath(basePath, name) {
  const normalizedBase = normalizeWslPath(basePath);
  if (normalizedBase === "~") {
    return normalizeWslPath(`/home/${name}`);
  }
  return path.posix.join(normalizedBase, name);
}

module.exports = {
  normalizeWslPath,
  validateWslDistro,
  toWslHostPath,
  fromWslHostPath,
  joinWslPath
};
