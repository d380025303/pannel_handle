const path = require("node:path");

function usesWindowsPaths(session, runtime = {}) {
  if (runtime.localBridge || session.type === "windows" || session.type === "ssh" && session.agentLocation === "local") return true;
  if (session.type === "wsl") return false;
  if (session.sshConfig?.remotePlatform) return session.sshConfig.remotePlatform === "windows";
  return /^[A-Za-z]:[\\/]/.test(runtime.workspaceCwd || session.cwd || "") || String(runtime.workspaceCwd || session.cwd || "").startsWith("\\\\");
}

function normalizeAdditionalDirectories(value, session, runtime) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("额外目录必须是目录列表。");
  const windows = usesWindowsPaths(session, runtime);
  const seen = new Set();
  return value.reduce((directories, item) => {
    if (typeof item !== "string" || /[\0\r\n*?]/.test(item)) throw new Error("额外目录不能包含通配符、换行或 NUL 字符。");
    const directory = item.trim();
    if (!directory) return directories;
    const absolute = windows ? /^[A-Za-z]:[\\/]/.test(directory) || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(directory) : directory.startsWith("/");
    if (!absolute) throw new Error(`额外目录必须是 OpenCode 运行环境中的${windows ? " Windows" : " POSIX"}绝对路径：${directory}`);
    const normalized = (windows ? path.win32 : path.posix).normalize(directory);
    const key = windows ? normalized.toLowerCase().replace(/[\\/]+$/, "") : normalized.replace(/\/+$/, "");
    if (!seen.has(key)) { seen.add(key); directories.push(directory); }
    return directories;
  }, []);
}

module.exports = { usesWindowsPaths, normalizeAdditionalDirectories };
