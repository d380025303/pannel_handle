const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
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
  "target",
  "coverage",
  ".cache",
  ".vite"
]);

const MAX_FILE_RESULTS = 200;
const MAX_TEXT_RESULTS = 300;
const MAX_TEXT_FILE_SIZE = 1024 * 1024;
const MAX_FILE_VISITED_ENTRIES = 100000;
const MAX_TEXT_VISITED_ENTRIES = 30000;
const SEARCH_TIMEOUT_MS = 30000;

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

  const displayPath = normalizeWslPath(session.cwd || "~") === "~"
    ? "/home"
    : normalizeWslPath(session.cwd);
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

function isExcludedDirectory(name) {
  return DEFAULT_EXCLUDED_DIRS.has(String(name || "").toLowerCase());
}

function hasExcludedPathSegment(relativePath) {
  return String(relativePath || "")
    .split(/[\\/]+/)
    .some((segment) => isExcludedDirectory(segment));
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

function throwIfCancelled(task) {
  if (!task?.cancelled) return;
  const error = new Error("Project search was cancelled.");
  error.code = "SEARCH_CANCELLED";
  throw error;
}

async function walkProject({ fsApi, hostRoot, onFile, onDirectory, maxResults, maxVisitedEntries, task }) {
  const queue = [{ hostPath: hostRoot, relativePath: "" }];
  let visitedEntries = 0;

  while (queue.length > 0 && visitedEntries < maxVisitedEntries) {
    throwIfCancelled(task);
    const current = queue.shift();
    let dirents;
    try {
      dirents = await fsApi.promises.readdir(current.hostPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      throwIfCancelled(task);
      visitedEntries += 1;
      if (visitedEntries > maxVisitedEntries) break;

      const childRelativePath = current.relativePath
        ? path.join(current.relativePath, dirent.name)
        : dirent.name;
      const childHostPath = path.join(current.hostPath, dirent.name);

      if (dirent.isDirectory()) {
        if (!isExcludedDirectory(dirent.name)) {
          if (onDirectory) {
            await onDirectory({ hostPath: childHostPath, relativePath: childRelativePath, name: dirent.name });
            if (maxResults && maxResults()) {
              return;
            }
          }
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

function isOrderedSubsequence(candidate, query) {
  const normalizedCandidate = String(candidate || "").toLowerCase();
  const normalizedQuery = String(query || "").toLowerCase();
  let queryIndex = 0;

  for (let candidateIndex = 0; candidateIndex < normalizedCandidate.length && queryIndex < normalizedQuery.length; candidateIndex += 1) {
    if (normalizedCandidate[candidateIndex] === normalizedQuery[queryIndex]) {
      queryIndex += 1;
    }
  }

  return queryIndex === normalizedQuery.length;
}

function normalizeRequestId(requestId) {
  const value = String(requestId || "").trim();
  if (!value) {
    throw new Error("A search request ID is required.");
  }
  return value;
}

function decodeRipgrepText(value) {
  if (typeof value?.text === "string") return value.text;
  if (typeof value?.bytes === "string") return Buffer.from(value.bytes, "base64").toString("utf-8");
  return "";
}

function byteOffsetToStringIndex(value, byteOffset) {
  return Buffer.from(value, "utf-8").subarray(0, Math.max(0, byteOffset)).toString("utf-8").length;
}

function normalizeRipgrepRelativePath(session, rawPath) {
  const withoutPrefix = String(rawPath || "").replace(/^(?:\.\\|\.\/)+/, "");
  if (session.type === "windows") {
    return path.normalize(withoutPrefix);
  }
  return withoutPrefix.replace(/\\/g, "/");
}

function parseRipgrepMatch(event, session, displayRoot) {
  if (event?.type !== "match" || !event.data) return null;
  const relativePath = normalizeRipgrepRelativePath(session, decodeRipgrepText(event.data.path));
  const fullLine = decodeRipgrepText(event.data.lines).replace(/\r?\n$/, "");
  const submatch = event.data.submatches?.[0];
  if (!relativePath || !submatch || !Number.isInteger(event.data.line_number)) return null;

  const fullMatchStart = byteOffsetToStringIndex(fullLine, submatch.start);
  const fullMatchEnd = byteOffsetToStringIndex(fullLine, submatch.end);
  const snippetStart = Math.max(0, fullMatchStart - 80);
  const snippetEnd = Math.min(fullLine.length, fullMatchEnd + 120);
  const displayRelativePath = toDisplayRelativePath(session, relativePath);

  return {
    path: toDisplayPath(session, displayRoot, relativePath),
    relativePath: displayRelativePath,
    name: session.type === "windows" ? path.basename(relativePath) : path.posix.basename(displayRelativePath),
    lineNumber: event.data.line_number,
    line: fullLine.slice(snippetStart, snippetEnd),
    matchStart: fullMatchStart - snippetStart,
    matchLength: fullMatchEnd - fullMatchStart
  };
}

function getRipgrepArgs(query) {
  const args = [
    "--json",
    "--fixed-strings",
    "--ignore-case",
    "--line-number",
    "--with-filename",
    "--hidden",
    "--max-filesize",
    String(MAX_TEXT_FILE_SIZE)
  ];
  for (const excludedDir of DEFAULT_EXCLUDED_DIRS) {
    args.push("--glob", `!${excludedDir}/**`);
  }
  args.push("--", query, ".");
  return args;
}

async function resolveBundledRipgrepPath() {
  const { rgPath } = await import("@vscode/ripgrep");
  return rgPath.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`
  );
}

async function createRipgrepInvocation(session, query, resolveRipgrepPath = resolveBundledRipgrepPath, displayRoot) {
  const args = getRipgrepArgs(query);
  const searchRoot = displayRoot || getWorkspaceRoot(session).displayRoot;
  if (session.type === "windows") {
    return {
      command: await resolveRipgrepPath(),
      args,
      cwd: searchRoot
    };
  }
  return {
    command: "wsl.exe",
    args: [
      "-d",
      String(session.wslDistro || "").trim(),
      "--cd",
      searchRoot,
      "--exec",
      "rg",
      ...args
    ]
  };
}

function createProcessError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRipgrepUnavailable(code, stderr) {
  return code === 127
    || code === 126
    || /(?:rg|ripgrep).*(?:not found|no such file)/i.test(stderr)
    || /(?:not found|no such file).*(?:rg|ripgrep)/i.test(stderr);
}

function runRipgrepSearch({ spawnProcess, invocation, session, displayRoot, task }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        windowsHide: true
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        reject(createProcessError("ripgrep is not available.", "RG_UNAVAILABLE"));
        return;
      }
      reject(error);
      return;
    }

    task.child = child;
    const results = [];
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    let reachedLimit = false;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (task.child === child) task.child = null;
      callback(value);
    };

    const consumeLine = (line) => {
      if (!line || reachedLimit) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const result = parseRipgrepMatch(event, session, displayRoot);
      if (!result) return;
      results.push(result);
      if (results.length >= MAX_TEXT_RESULTS) {
        reachedLimit = true;
        child.kill();
      }
    };

    const timer = setTimeout(() => {
      task.timedOut = true;
      child.kill();
    }, SEARCH_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) consumeLine(line);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 8192) {
        stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
      }
    });
    child.on("error", (error) => {
      if (error?.code === "ENOENT") {
        settle(reject, createProcessError("ripgrep is not available.", "RG_UNAVAILABLE"));
        return;
      }
      settle(reject, error);
    });
    child.on("close", (code) => {
      consumeLine(stdoutBuffer);
      if (task.cancelled) {
        settle(reject, createProcessError("Project search was cancelled.", "SEARCH_CANCELLED"));
        return;
      }
      if (task.timedOut) {
        settle(reject, createProcessError("Project search timed out.", "SEARCH_TIMEOUT"));
        return;
      }
      if (reachedLimit || code === 0 || code === 1) {
        settle(resolve, results);
        return;
      }
      if (isRipgrepUnavailable(code, stderr)) {
        settle(reject, createProcessError("ripgrep is not available.", "RG_UNAVAILABLE"));
        return;
      }
      settle(reject, new Error(stderr.trim() || `ripgrep failed with exit code ${code}.`));
    });
  });
}

function collectProcessOutput({ spawnProcess, command, args, task }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, { windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    task.child = child;
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => child.kill(), SEARCH_TIMEOUT_MS);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (task.child === child) task.child = null;
      callback(value);
    };
    child.stdout?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      if (task.cancelled) {
        finish(reject, createProcessError("Project search was cancelled.", "SEARCH_CANCELLED"));
      } else if (code === 0) {
        finish(resolve, Buffer.concat(chunks));
      } else {
        finish(resolve, null);
      }
    });
  });
}

async function listWslGitFiles({ spawnProcess, session, displayRoot, task }) {
  const output = await collectProcessOutput({
    spawnProcess,
    command: "wsl.exe",
    args: [
      "-d",
      String(session.wslDistro || "").trim(),
      "--cd",
      displayRoot,
      "--exec",
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z"
    ],
    task
  });
  if (!output) return null;
  return output.toString("utf-8").split("\0").filter((entry) => entry && !hasExcludedPathSegment(entry));
}

async function searchTextFile({ fsApi, hostPath, relativePath, name, query, session, displayRoot, results, task }) {
  throwIfCancelled(task);
  let stat;
  try {
    stat = await fsApi.promises.stat(hostPath);
  } catch {
    return;
  }
  if (Number(stat.size || 0) > MAX_TEXT_FILE_SIZE) return;

  let buffer;
  try {
    buffer = await fsApi.promises.readFile(hostPath);
  } catch {
    return;
  }
  throwIfCancelled(task);
  if (buffer.length > MAX_TEXT_FILE_SIZE || isLikelyBinary(buffer)) return;

  const matches = getLineMatches(buffer.toString("utf-8"), query, MAX_TEXT_RESULTS - results.length);
  for (const match of matches) {
    results.push({
      path: toDisplayPath(session, displayRoot, relativePath),
      relativePath: toDisplayRelativePath(session, relativePath),
      name,
      ...match
    });
    if (results.length >= MAX_TEXT_RESULTS) break;
  }
}

async function runFallbackTextSearch({ fsApi, spawnProcess, session, query, root, task }) {
  const { hostRoot, displayRoot } = root;
  const results = [];
  const gitFiles = session.type === "wsl"
    ? await listWslGitFiles({ spawnProcess, session, displayRoot, task }).catch((error) => {
      if (error?.code === "SEARCH_CANCELLED") throw error;
      return null;
    })
    : null;

  if (gitFiles) {
    for (const relativePath of gitFiles) {
      if (results.length >= MAX_TEXT_RESULTS) break;
      await searchTextFile({
        fsApi,
        hostPath: path.join(hostRoot, ...relativePath.split("/")),
        relativePath,
        name: path.posix.basename(relativePath),
        query,
        session,
        displayRoot,
        results,
        task
      });
    }
    return { root: displayRoot, results, engine: "fallback" };
  }

  await walkProject({
    fsApi,
    hostRoot,
    maxVisitedEntries: MAX_TEXT_VISITED_ENTRIES,
    task,
    maxResults: () => results.length >= MAX_TEXT_RESULTS,
    onFile: ({ hostPath, relativePath, name }) => searchTextFile({
      fsApi,
      hostPath,
      relativePath,
      name,
      query,
      session,
      displayRoot,
      results,
      task
    })
  });
  return { root: displayRoot, results, engine: "fallback" };
}

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

  async function searchFiles(sessionId, query, rootPath) {
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
          isOrderedSubsequence(name, normalizedQuery)
          || isOrderedSubsequence(displayRelativePath, normalizedQuery)
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

  async function searchWorkspaceEntries(sessionId, query) {
    const normalizedQuery = normalizeQuery(query);
    const session = terminalManager.getSession(sessionId);
    if (!session) {
      throw new Error("Session is not running.");
    }

    const matchesQuery = (name, relativePath) => !normalizedQuery
      || isOrderedSubsequence(name, normalizedQuery)
      || isOrderedSubsequence(relativePath, normalizedQuery);
    const results = [];

    if (session.type !== "ssh") {
      const localSession = getSession(terminalManager, sessionId);
      let configuredRoot = localSession.cwd || ".";
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
        onFile: addResult("file")
      });
      return { root: displayRoot, results };
    }

    if (!remoteFileService) {
      throw new Error("Remote file search is not available.");
    }
    const home = await remoteFileService.getHome(sessionId);
    const configuredCwd = String(session.cwd || "~").trim() || "~";
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
        if (entry.type === "directory" && !isExcludedDirectory(entry.name)) {
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

  async function searchText(sessionId, query, requestId, rootPath) {
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
        return await runFallbackTextSearch({ fsApi, spawnProcess, session, query: normalizedQuery, root, task });
      }
      const { displayRoot } = root;
      try {
        const invocation = await createRipgrepInvocation(session, normalizedQuery, resolveRipgrepPath, displayRoot);
        throwIfCancelled(task);
        const results = await runRipgrepSearch({ spawnProcess, invocation, session, displayRoot, task });
        return { root: displayRoot, results, engine: "ripgrep" };
      } catch (error) {
        if (session.type !== "wsl" || error?.code !== "RG_UNAVAILABLE") throw error;
        throwIfCancelled(task);
        return await runFallbackTextSearch({ fsApi, spawnProcess, session, query: normalizedQuery, root, task });
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
