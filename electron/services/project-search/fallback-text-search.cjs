const path = require("node:path");
const { runTextQuerySearch } = require("./text-query-search.cjs");
const { MAX_TEXT_FILE_SIZE, MAX_TEXT_RESULTS, MAX_TEXT_VISITED_ENTRIES, SEARCH_TIMEOUT_MS } = require("./search-limits.cjs");
const { hasExcludedPathSegment, isLikelyBinary, getLineMatches } = require("./search-matching.cjs");
const { throwIfCancelled, createProcessError } = require("./search-task.cjs");
const { walkProject } = require("./project-walker.cjs");
const { toDisplayPath, toDisplayRelativePath } = require("./search-paths.cjs");

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

async function searchTextFile({ fsApi, hostPath, relativePath, name, query, session, displayRoot, results, task, options, matchLines = getLineMatches }) {
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

  const matches = await matchLines(buffer.toString("utf-8"), query, MAX_TEXT_RESULTS - results.length, options);
  throwIfCancelled(task);
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

function runFallbackTextSearch(args) {
  return runTextQuerySearch(args.task, args.options || {},
    (matchLines) => runFallbackTextSearchImpl({ ...args, matchLines }), args.textRegexTimeoutMs);
}

async function runFallbackTextSearchImpl({ fsApi, spawnProcess, session, query, root, task, options = {}, matchLines }) {
  const { hostRoot, displayRoot } = root;
  const results = [];
  const gitFiles = session.type === "wsl" && !options.includeIgnored
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
        task,
        options,
        matchLines
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
      task,
      options,
      matchLines
    }),
    includeIgnored: options.includeIgnored
  });
  return { root: displayRoot, results, engine: "fallback" };
}

module.exports = {
  collectProcessOutput,
  listWslGitFiles,
  searchTextFile,
  runFallbackTextSearch
};
