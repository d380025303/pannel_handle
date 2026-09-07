const os = require("node:os");
const path = require("node:path");
const { normalizeWslPath, toWslHostPath } = require("../../core/wsl-paths.cjs");

function normalizeWindowsPath(value, fallbackPath) {
  const rawPath = String(value || fallbackPath || os.homedir()).trim() || fallbackPath || os.homedir();
  if (rawPath.includes("\0")) {
    throw new Error("Invalid path.");
  }
  if (path.win32.isAbsolute(rawPath) || path.isAbsolute(rawPath)) {
    return path.resolve(rawPath);
  }
  return path.resolve(fallbackPath || os.homedir(), rawPath);
}

function getSession(terminalManager, sessionId) {
  const session = terminalManager.getSession(sessionId);
  if (!session) {
    throw new Error("Session is not running.");
  }
  if (!["windows", "wsl"].includes(session.type)) {
    throw new Error("Project search is only available for Windows and WSL sessions.");
  }
  return session;
}

function getWorkspaceRoot(session) {
  if (session.type === "windows") {
    const displayPath = normalizeWindowsPath(session.cwd, os.homedir());
    return {
      displayRoot: displayPath,
      hostRoot: displayPath
    };
  }

  const configuredPath = session.cwd || "~";
  const displayPath = normalizeWslPath(configuredPath) === "~"
    ? "/home"
    : normalizeWslPath(configuredPath);
  return {
    displayRoot: displayPath,
    hostRoot: toWslHostPath(session.wslDistro, displayPath)
  };
}

function hasParentSegment(value) {
  return String(value || "").replace(/\\/g, "/").split("/").includes("..");
}

function isPathInside(pathApi, parentPath, childPath) {
  const relativePath = pathApi.relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith(`..${pathApi.sep}`) && relativePath !== ".." && !pathApi.isAbsolute(relativePath));
}

async function resolveSearchRoot(fsApi, session, rootPath = ".") {
  const workspace = getWorkspaceRoot(session);
  const rawPath = String(rootPath || ".").trim() || ".";
  if (rawPath.includes("\0") || hasParentSegment(rawPath)) {
    throw new Error("Search directory must stay inside the session working directory.");
  }

  let displayRoot;
  if (session.type === "windows") {
    displayRoot = path.win32.isAbsolute(rawPath)
      ? path.win32.normalize(rawPath)
      : path.win32.resolve(workspace.displayRoot, rawPath);
    if (!isPathInside(path.win32, workspace.displayRoot, displayRoot)) {
      throw new Error("Search directory must stay inside the session working directory.");
    }
  } else {
    const normalizedInput = rawPath.replace(/\\/g, "/");
    displayRoot = normalizedInput.startsWith("/")
      ? path.posix.normalize(normalizedInput)
      : path.posix.resolve(workspace.displayRoot, normalizedInput);
    if (!isPathInside(path.posix, workspace.displayRoot, displayRoot)) {
      throw new Error("Search directory must stay inside the session working directory.");
    }
  }

  const hostRoot = session.type === "windows"
    ? displayRoot
    : toWslHostPath(session.wslDistro, displayRoot);
  let stat;
  try {
    stat = await fsApi.promises.stat(hostRoot);
  } catch {
    throw new Error("Search directory does not exist.");
  }
  if (!stat.isDirectory()) {
    throw new Error("Search path must be a directory.");
  }

  let realWorkspaceRoot;
  let realHostRoot;
  try {
    [realWorkspaceRoot, realHostRoot] = await Promise.all([
      fsApi.promises.realpath(workspace.hostRoot),
      fsApi.promises.realpath(hostRoot)
    ]);
  } catch {
    throw new Error("Search directory could not be resolved.");
  }
  if (!isPathInside(path.win32, realWorkspaceRoot, realHostRoot)) {
    throw new Error("Search directory must stay inside the session working directory.");
  }

  return { displayRoot, hostRoot, workspaceDisplayRoot: workspace.displayRoot };
}

function toDisplayPath(session, displayRoot, relativePath) {
  if (!relativePath) return displayRoot;
  if (session.type === "windows") {
    return path.join(displayRoot, relativePath);
  }
  return path.posix.join(displayRoot, relativePath.replace(/\\/g, "/"));
}

function toDisplayRelativePath(session, relativePath) {
  return session.type === "windows" ? relativePath : relativePath.replace(/\\/g, "/");
}

module.exports = {
  normalizeWindowsPath,
  getSession,
  getWorkspaceRoot,
  hasParentSegment,
  isPathInside,
  resolveSearchRoot,
  toDisplayPath,
  toDisplayRelativePath
};
