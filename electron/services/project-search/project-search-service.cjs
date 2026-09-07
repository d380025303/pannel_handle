const { runFallbackTextSearch } = require("./fallback-text-search.cjs");
const { parseRipgrepMatch, resolveBundledRipgrepPath, createRipgrepInvocation, runRipgrepSearch } = require("./ripgrep-search.cjs");
const { walkProject } = require("./project-walker.cjs");
const { throwIfCancelled, normalizeRequestId } = require("./search-task.cjs");
const { isExcludedDirectory, normalizeQuery, matchesFileQuery } = require("./search-matching.cjs");
const { getSession, resolveSearchRoot, toDisplayPath, toDisplayRelativePath } = require("./search-paths.cjs");
const { MAX_FILE_RESULTS, MAX_TEXT_RESULTS, MAX_TEXT_FILE_SIZE, MAX_FILE_VISITED_ENTRIES } = require("./search-limits.cjs");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function createProjectSearchService({
  terminalManager,
  remoteFileService,
  fsApi = fs,
  spawnProcess = spawn,
  resolveRipgrepPath = resolveBundledRipgrepPath,
  forceTextFallback = false
}) {
  const activeTextSearches = new Map();

  function cancelTextSearch(sessionId, requestId) {
    const active = activeTextSearches.get(String(sessionId || ""));
    if (!active || active.requestId !== String(requestId || "")) return false;
    active.cancelled = true;
    active.child?.kill();
    return true;
  }

  function cancelActiveTextSearch(sessionId) {
    const active = activeTextSearches.get(String(sessionId || ""));
    if (!active) return;
    active.cancelled = true;
    active.child?.kill();
  }

  async function listDirectories(sessionId, rootPath) {
    const session = getSession(terminalManager, sessionId);
    const root = await resolveSearchRoot(fsApi, session, rootPath);
    const dirents = await fsApi.promises.readdir(root.hostRoot, { withFileTypes: true });
    const directories = dirents
      .filter((dirent) => dirent.isDirectory() && !isExcludedDirectory(dirent.name))
      .map((dirent) => ({
        name: dirent.name,
        path: toDisplayPath(session, root.displayRoot, dirent.name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      workspaceRoot: root.workspaceDisplayRoot,
      path: root.displayRoot,
      directories
    };
  }

  async function searchFiles(sessionId, query, rootPath, options = {}) {
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) {
      return { root: "", results: [] };
    }

    const session = getSession(terminalManager, sessionId);
    const { hostRoot, displayRoot } = await resolveSearchRoot(fsApi, session, rootPath);
    const results = [];

    await walkProject({
      fsApi,
      hostRoot,
      maxVisitedEntries: MAX_FILE_VISITED_ENTRIES,
      maxResults: () => results.length >= MAX_FILE_RESULTS,
      onFile: async ({ relativePath, name }) => {
        const displayRelativePath = toDisplayRelativePath(session, relativePath);
        if (
          matchesFileQuery(name, normalizedQuery, options)
          || matchesFileQuery(displayRelativePath, normalizedQuery, options)
        ) {
          results.push({
            path: toDisplayPath(session, displayRoot, relativePath),
            relativePath: displayRelativePath,
            name
          });
        }
      },
      includeIgnored: options.includeIgnored
    });

    return { root: displayRoot, results };
  }

  async function searchWorkspaceEntries(sessionId, query, rootPath, options = {}) {
    const normalizedQuery = normalizeQuery(query);
    const session = terminalManager.getSession(sessionId);
    if (!session) {
      throw new Error("Session is not running.");
    }

    const matchesQuery = (name, relativePath) => !normalizedQuery
      || matchesFileQuery(name, normalizedQuery, options)
      || matchesFileQuery(relativePath, normalizedQuery, options);
    const results = [];

    if (session.type !== "ssh") {
      const localSession = getSession(terminalManager, sessionId);
      let configuredRoot = rootPath || localSession.cwd || ".";
      if (String(configuredRoot).startsWith("~") && remoteFileService) {
        const home = await remoteFileService.getHome(sessionId);
        configuredRoot = configuredRoot === "~"
          ? home
          : localSession.type === "windows"
            ? path.win32.join(home, configuredRoot.slice(2))
            : path.posix.join(home, configuredRoot.slice(2));
      }
      const { hostRoot, displayRoot } = await resolveSearchRoot(fsApi, localSession, configuredRoot);
      const addResult = (type) => async ({ relativePath, name }) => {
        const displayRelativePath = toDisplayRelativePath(localSession, relativePath);
        if (matchesQuery(name, displayRelativePath)) {
          results.push({
            path: toDisplayPath(localSession, displayRoot, relativePath),
            relativePath: displayRelativePath,
            name,
            type
          });
        }
      };
      await walkProject({
        fsApi,
        hostRoot,
        maxVisitedEntries: MAX_FILE_VISITED_ENTRIES,
        maxResults: () => results.length >= MAX_FILE_RESULTS,
        onDirectory: addResult("directory"),
        onFile: addResult("file"),
        includeIgnored: options.includeIgnored
      });
      return { root: displayRoot, results };
    }

    if (!remoteFileService) {
      throw new Error("Remote file search is not available.");
    }
    const home = await remoteFileService.getHome(sessionId);
    const configuredCwd = String(rootPath || session.cwd || "~").trim() || "~";
    const root = configuredCwd === "~"
      ? home
      : configuredCwd.startsWith("~/")
        ? path.posix.join(home, configuredCwd.slice(2))
        : configuredCwd.startsWith("/")
          ? path.posix.normalize(configuredCwd)
          : path.posix.join(home, configuredCwd);
    const queue = [{ path: root, relativePath: "" }];
    let visitedEntries = 0;

    while (queue.length > 0 && visitedEntries < MAX_FILE_VISITED_ENTRIES && results.length < MAX_FILE_RESULTS) {
      const current = queue.shift();
      let entries;
      try {
        entries = await remoteFileService.list(sessionId, current.path);
      } catch {
        continue;
      }
      for (const entry of entries) {
        visitedEntries += 1;
        if (visitedEntries > MAX_FILE_VISITED_ENTRIES || results.length >= MAX_FILE_RESULTS) break;
        const relativePath = current.relativePath
          ? path.posix.join(current.relativePath, entry.name)
          : entry.name;
        if (entry.type === "directory" && (!isExcludedDirectory(entry.name) || (options.includeIgnored && ![".git", ".hg", ".svn"].includes(entry.name)))) {
          if (matchesQuery(entry.name, relativePath)) {
            results.push({ path: entry.path, relativePath, name: entry.name, type: "directory" });
          }
          queue.push({ path: entry.path, relativePath });
        } else if (entry.type === "file" && matchesQuery(entry.name, relativePath)) {
          results.push({ path: entry.path, relativePath, name: entry.name, type: "file" });
        }
      }
    }

    return { root, results };
  }

  async function searchText(sessionId, query, requestId, rootPath, options = {}) {
    const normalizedQuery = normalizeQuery(query);
    const normalizedRequestId = normalizeRequestId(requestId);
    if (!normalizedQuery) {
      return { root: "", results: [], engine: "ripgrep" };
    }

    const session = getSession(terminalManager, sessionId);
    const root = await resolveSearchRoot(fsApi, session, rootPath);
    cancelActiveTextSearch(sessionId);
    const task = {
      requestId: normalizedRequestId,
      child: null,
      cancelled: false,
      timedOut: false
    };
    activeTextSearches.set(String(sessionId), task);

    try {
      if (forceTextFallback) {
        return await runFallbackTextSearch({ fsApi, spawnProcess, session, query: normalizedQuery, root, task, options });
      }
      const { displayRoot } = root;
      try {
        const invocation = await createRipgrepInvocation(session, normalizedQuery, resolveRipgrepPath, displayRoot, options);
        throwIfCancelled(task);
        const results = await runRipgrepSearch({ spawnProcess, invocation, session, displayRoot, task });
        return { root: displayRoot, results, engine: "ripgrep" };
      } catch (error) {
        if (session.type !== "wsl" || error?.code !== "RG_UNAVAILABLE") throw error;
        throwIfCancelled(task);
        return await runFallbackTextSearch({ fsApi, spawnProcess, session, query: normalizedQuery, root, task, options });
      }
    } finally {
      if (activeTextSearches.get(String(sessionId)) === task) {
        activeTextSearches.delete(String(sessionId));
      }
    }
  }

  return {
    listDirectories,
    searchFiles,
    searchWorkspaceEntries,
    searchText,
    cancelTextSearch
  };
}

module.exports = {
  MAX_FILE_RESULTS,
  MAX_TEXT_FILE_SIZE,
  MAX_TEXT_RESULTS,
  createProjectSearchService,
  createRipgrepInvocation,
  parseRipgrepMatch,
  resolveSearchRoot
};
