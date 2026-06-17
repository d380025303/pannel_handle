const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeWslPath, toWslHostPath } = require("./remote-file-service.cjs");

const DEFAULT_EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "release",
  "build",
  "coverage",
  ".cache",
  ".vite"
]);

const MAX_FILE_RESULTS = 200;
const MAX_TEXT_RESULTS = 300;
const MAX_TEXT_FILE_SIZE = 1024 * 1024;
const MAX_VISITED_ENTRIES = 30000;

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
  if (session.type === "ssh") {
    throw new Error("Project search is only available for Windows and WSL sessions.");
  }
  if (!["windows", "wsl"].includes(session.type)) {
    throw new Error("Project search is only available for Windows and WSL sessions.");
  }
  return session;
}

function getSearchRoot(session) {
  if (session.type === "windows") {
    const displayPath = normalizeWindowsPath(session.cwd, os.homedir());
    return {
      displayRoot: displayPath,
      hostRoot: displayPath
    };
  }

  const displayPath = normalizeWslPath(session.cwd || "~") === "~"
    ? "/home"
    : normalizeWslPath(session.cwd);
  return {
    displayRoot: displayPath,
    hostRoot: toWslHostPath(session.wslDistro, displayPath)
  };
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

function isExcludedDirectory(name) {
  return DEFAULT_EXCLUDED_DIRS.has(String(name || "").toLowerCase());
}

function isLikelyBinary(buffer) {
  if (!buffer || buffer.length === 0) {
    return false;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

function getLineMatches(content, query, limit) {
  const normalizedQuery = query.toLowerCase();
  const lines = content.split(/\r?\n/);
  const matches = [];
  for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
    const line = lines[index];
    const matchIndex = line.toLowerCase().indexOf(normalizedQuery);
    if (matchIndex !== -1) {
      const start = Math.max(0, matchIndex - 80);
      const end = Math.min(line.length, matchIndex + query.length + 120);
      matches.push({
        lineNumber: index + 1,
        line: line.slice(start, end),
        matchStart: matchIndex - start,
        matchLength: query.length
      });
    }
  }
  return matches;
}

async function walkProject({ fsApi, hostRoot, onFile, maxResults }) {
  const queue = [{ hostPath: hostRoot, relativePath: "" }];
  let visitedEntries = 0;

  while (queue.length > 0 && visitedEntries < MAX_VISITED_ENTRIES) {
    const current = queue.shift();
    let dirents;
    try {
      dirents = await fsApi.promises.readdir(current.hostPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      visitedEntries += 1;
      if (visitedEntries > MAX_VISITED_ENTRIES) break;

      const childRelativePath = current.relativePath
        ? path.join(current.relativePath, dirent.name)
        : dirent.name;
      const childHostPath = path.join(current.hostPath, dirent.name);

      if (dirent.isDirectory()) {
        if (!isExcludedDirectory(dirent.name)) {
          queue.push({ hostPath: childHostPath, relativePath: childRelativePath });
        }
        continue;
      }

      if (dirent.isFile()) {
        await onFile({ hostPath: childHostPath, relativePath: childRelativePath, name: dirent.name });
        if (maxResults && maxResults()) {
          return;
        }
      }
    }
  }
}

function normalizeQuery(query) {
  return String(query || "").trim();
}

function createProjectSearchService({ terminalManager, fsApi = fs }) {
  async function searchFiles(sessionId, query) {
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) {
      return { root: "", results: [] };
    }

    const session = getSession(terminalManager, sessionId);
    const { hostRoot, displayRoot } = getSearchRoot(session);
    const normalizedNeedle = normalizedQuery.toLowerCase();
    const results = [];

    await walkProject({
      fsApi,
      hostRoot,
      maxResults: () => results.length >= MAX_FILE_RESULTS,
      onFile: async ({ relativePath, name }) => {
        const displayRelativePath = toDisplayRelativePath(session, relativePath);
        if (
          name.toLowerCase().includes(normalizedNeedle)
          || displayRelativePath.toLowerCase().includes(normalizedNeedle)
        ) {
          results.push({
            path: toDisplayPath(session, displayRoot, relativePath),
            relativePath: displayRelativePath,
            name
          });
        }
      }
    });

    return { root: displayRoot, results };
  }

  async function searchText(sessionId, query) {
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) {
      return { root: "", results: [] };
    }

    const session = getSession(terminalManager, sessionId);
    const { hostRoot, displayRoot } = getSearchRoot(session);
    const results = [];

    await walkProject({
      fsApi,
      hostRoot,
      maxResults: () => results.length >= MAX_TEXT_RESULTS,
      onFile: async ({ hostPath, relativePath, name }) => {
        let stat;
        try {
          stat = await fsApi.promises.stat(hostPath);
        } catch {
          return;
        }
        if (Number(stat.size || 0) > MAX_TEXT_FILE_SIZE) {
          return;
        }

        let buffer;
        try {
          buffer = await fsApi.promises.readFile(hostPath);
        } catch {
          return;
        }
        if (buffer.length > MAX_TEXT_FILE_SIZE || isLikelyBinary(buffer)) {
          return;
        }

        const matches = getLineMatches(buffer.toString("utf-8"), normalizedQuery, MAX_TEXT_RESULTS - results.length);
        for (const match of matches) {
          results.push({
            path: toDisplayPath(session, displayRoot, relativePath),
            relativePath: toDisplayRelativePath(session, relativePath),
            name,
            ...match
          });
          if (results.length >= MAX_TEXT_RESULTS) {
            break;
          }
        }
      }
    });

    return { root: displayRoot, results };
  }

  return {
    searchFiles,
    searchText
  };
}

module.exports = {
  MAX_FILE_RESULTS,
  MAX_TEXT_FILE_SIZE,
  MAX_TEXT_RESULTS,
  createProjectSearchService
};
