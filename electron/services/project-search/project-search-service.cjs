const { runFileQuerySearch, createFileQueryCollector } = require("./file-query-search.cjs");
const { runFallbackTextSearch } = require("./fallback-text-search.cjs");
const { parseRipgrepMatch, resolveBundledRipgrepPath, createRipgrepInvocation, runRipgrepSearch } = require("./ripgrep-search.cjs");
const { walkProject } = require("./project-walker.cjs");
const { throwIfCancelled, normalizeRequestId } = require("./search-task.cjs");
const { isExcludedDirectory, normalizeQuery } = require("./search-matching.cjs");
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
  forceTextFallback = false,
  fileRegexTimeoutMs,
  textRegexTimeoutMs
}) {
  const activeTextSearches = new Map();
  const activeFileSearches = new Map();

  function cancelFileSearch(sessionId, requestId) {
    const task = activeFileSearches.get(String(sessionId));
    if (!task || task.requestId !== String(requestId || "")) return false;
    task.cancelled = true;
    task.cancelMatching?.();
    return true;
  }

  async function runFileSearch(sessionId, query, rootPath, options, requestId, search) {
    // Legacy callers without an ID remain independent of cancellable modal searches.
    const task = { cancelled: false };
    const key = String(sessionId);
    if (requestId !== undefined) {
      task.requestId = normalizeRequestId(requestId);
      const previous = activeFileSearches.get(key);
      if (previous) cancelFileSearch(sessionId, previous.requestId);
      activeFileSearches.set(key, task);
    }
    try {
      return await runFileQuerySearch(normalizeQuery(query), options,
        (matches) => search(sessionId, query, rootPath, options, matches, task), fileRegexTimeoutMs, task);
    } finally {
      if (activeFileSearches.get(key) === task) activeFileSearches.delete(key);
    }
  }

  function cancelTextSearch(sessionId, requestId) {
    const active = activeTextSearches.get(String(sessionId || ""));
    if (!active || active.requestId !== String(requestId || "")) return false;
    active.cancelled = true;
    active.cancelMatching?.();
    active.child?.kill();
    return true;
  }

  function cancelActiveTextSearch(sessionId) {
    const active = activeTextSearches.get(String(sessionId || ""));
    if (!active) return;
    active.cancelled = true;
    active.cancelMatching?.();
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

  async function searchFilesImpl(sessionId, query, rootPath, options, matchesQuery, task) {
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) {
      return { root: "", results: [] };
    }

    throwIfCancelled(task);
    const session = getSession(terminalManager, sessionId);
    const { hostRoot, displayRoot } = await resolveSearchRoot(fsApi, session, rootPath);
    const results = [];
    const collector = createFileQueryCollector(matchesQuery, results, options.regex ? 256 : 1);

    await walkProject({
      fsApi,
      task,
      hostRoot,
      maxVisitedEntries: MAX_FILE_VISITED_ENTRIES,
      maxResults: () => results.length >= MAX_FILE_RESULTS,
      onFile: async ({ relativePath, name }) => {
        const displayRelativePath = toDisplayRelativePath(session, relativePath);
        await collector.add({
          path: toDisplayPath(session, displayRoot, relativePath),
          relativePath: displayRelativePath,
          name
        });
      },
      includeIgnored: options.includeIgnored
    });

    throwIfCancelled(task);
    await collector.flush();
    return { root: displayRoot, results };
  }

  async function searchWorkspaceEntriesImpl(sessionId, query, rootPath, options, matchesQuery, task) {
    throwIfCancelled(task);
    const acceptsType = (type) => !options.entryType || options.entryType === "all" || options.entryType === type;
    const session = terminalManager.getSession(sessionId);
    if (!session) {
      throw new Error("Session is not running.");
    }

    const results = [];
    const collector = createFileQueryCollector(matchesQuery, results, options.regex ? 256 : 1);

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
        if (!acceptsType(type)) return;
        const displayRelativePath = toDisplayRelativePath(localSession, relativePath);
        await collector.add({
          path: toDisplayPath(localSession, displayRoot, relativePath),
          relativePath: displayRelativePath,
          name,
          type
        });
      };
      await walkProject({
        fsApi,
        task,
        hostRoot,
        maxVisitedEntries: MAX_FILE_VISITED_ENTRIES,
        maxResults: () => results.length >= MAX_FILE_RESULTS,
        onDirectory: addResult("directory"),
        onFile: addResult("file"),
        includeIgnored: options.includeIgnored
      });
      throwIfCancelled(task);
      await collector.flush();
      return { root: displayRoot, results };
    }

    if (!remoteFileService) {
      throw new Error("Remote file search is not available.");
    }
    const home = await remoteFileService.getHome(sessionId);
    throwIfCancelled(task);
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
      throwIfCancelled(task);
      const current = queue.shift();
      let entries;
      try {
        entries = await remoteFileService.list(sessionId, current.path);
      } catch {
        continue;
      }
      throwIfCancelled(task);
      for (const entry of entries) {
        throwIfCancelled(task);
        visitedEntries += 1;
        if (visitedEntries > MAX_FILE_VISITED_ENTRIES || results.length >= MAX_FILE_RESULTS) break;
        const relativePath = current.relativePath
          ? path.posix.join(current.relativePath, entry.name)
          : entry.name;
        if (entry.type === "directory" && (!isExcludedDirectory(entry.name) || (options.includeIgnored && ![".git", ".hg", ".svn"].includes(entry.name)))) {
          if (acceptsType("directory")) await collector.add({ path: entry.path, relativePath, name: entry.name, type: "directory" });
          queue.push({ path: entry.path, relativePath });
        } else if (entry.type === "file") {
          if (acceptsType("file")) await collector.add({ path: entry.path, relativePath, name: entry.name, type: "file" });
        }
      }
    }

    throwIfCancelled(task);
    await collector.flush();
    return { root, results };
  }

  function searchFiles(sessionId, query, rootPath, options = {}, requestId) {
    return runFileSearch(sessionId, query, rootPath, options, requestId, searchFilesImpl);
  }

  function searchWorkspaceEntries(sessionId, query, rootPath, options = {}, requestId) {
    return runFileSearch(sessionId, query, rootPath, options, requestId, searchWorkspaceEntriesImpl);
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
        return await runFallbackTextSearch({ fsApi, spawnProcess, session, query: normalizedQuery, root, task, options, textRegexTimeoutMs });
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
        return await runFallbackTextSearch({ fsApi, spawnProcess, session, query: normalizedQuery, root, task, options, textRegexTimeoutMs });
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
    cancelTextSearch,
    cancelFileSearch
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
