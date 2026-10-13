const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { DEFAULT_EXCLUDED_DIRS, MAX_TEXT_FILE_SIZE, SEARCH_TIMEOUT_MS } = require("./search-limits.cjs");
const { getWorkspaceRoot, toDisplayPath, toDisplayRelativePath } = require("./search-paths.cjs");
const { createProcessError } = require("./search-task.cjs");

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

function getRipgrepArgs(query, options = {}) {
  const args = [
    "--json",
    "--line-number",
    "--with-filename",
    "--hidden",
    "--max-filesize",
    String(MAX_TEXT_FILE_SIZE)
  ];
  if (!options.regex) args.push("--fixed-strings");
  if (!options.caseSensitive) args.push("--ignore-case");
  if (options.wholeWord) args.push("--word-regexp");
  if (options.includeIgnored) args.push("--no-ignore");
  for (const excludedDir of DEFAULT_EXCLUDED_DIRS) {
    if (!options.includeIgnored || [".git", ".hg", ".svn"].includes(excludedDir)) {
      args.push("--glob", `!${excludedDir}/**`);
    }
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

async function createRipgrepInvocation(session, query, resolveRipgrepPath = resolveBundledRipgrepPath, displayRoot, options = {}) {
  const args = getRipgrepArgs(query, options);
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

function isRipgrepUnavailable(code, stderr) {
  return code === 127
    || code === 126
    || /(?:rg|ripgrep).*(?:not found|no such file)/i.test(stderr)
    || /(?:not found|no such file).*(?:rg|ripgrep)/i.test(stderr);
}

function runRipgrepSearch({ spawnProcess, invocation, session, displayRoot, task, timeoutMs = SEARCH_TIMEOUT_MS }) {
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
    let worker;
    try {
      worker = new Worker(path.join(__dirname, "ripgrep-search-worker.cjs"), {
        workerData: { session: { type: session.type }, displayRoot }
      });
    } catch (error) {
      child.kill();
      task.child = null;
      reject(error);
      return;
    }
    let stderr = "";
    let settled = false;
    let processClosed = false;
    let parserDone = false;
    let exitCode;
    let results = [];
    let reachedLimit = false;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (task.child === child) task.child = null;
      if (task.cancelMatching === cancel) task.cancelMatching = null;
      void worker.terminate();
      // Drain a killed process pipe even when backpressure paused stdout.
      child.stdout?.resume();
      callback(value);
    };
    const cancel = () => {
      child.kill();
      settle(reject, createProcessError("Project search was cancelled.", "SEARCH_CANCELLED"));
    };
    task.cancelMatching = cancel;
    const finish = () => {
      if (settled || !processClosed || !parserDone) return;
      if (task.cancelled) return cancel();
      if (reachedLimit || exitCode === 0 || exitCode === 1) {
        settle(resolve, results);
      } else if (isRipgrepUnavailable(exitCode, stderr)) {
        settle(reject, createProcessError("ripgrep is not available.", "RG_UNAVAILABLE"));
      } else {
        settle(reject, new Error(stderr.trim() || `ripgrep failed with exit code ${exitCode}.`));
      }
    };
    const timer = setTimeout(() => {
      task.timedOut = true;
      child.kill();
      settle(reject, createProcessError("Project search timed out.", "SEARCH_TIMEOUT"));
    }, timeoutMs);

    worker.on("message", (message) => {
      if (settled) return;
      if (message.type === "ack") {
        child.stdout?.resume();
      } else if (message.type === "done") {
        results = message.results;
        reachedLimit = message.reachedLimit;
        parserDone = true;
        if (reachedLimit) {
          child.kill();
          child.stdout?.resume();
        }
        finish();
      }
    });
    worker.on("error", (error) => {
      child.kill();
      settle(reject, error);
    });
    worker.on("exit", (code) => {
      if (!settled) {
        child.kill();
        settle(reject, new Error(`Ripgrep search worker exited unexpectedly (${code}).`));
      }
    });
    child.stdout?.on("data", (chunk) => {
      if (settled || parserDone) return;
      child.stdout.pause();
      worker.postMessage({ type: "chunk", chunk });
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 8192) {
        stderr += (Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk)).slice(0, 8192 - stderr.length);
      }
    });
    child.on("error", (error) => {
      settle(reject, error?.code === "ENOENT"
        ? createProcessError("ripgrep is not available.", "RG_UNAVAILABLE") : error);
    });
    child.on("close", (code) => {
      if (settled) return;
      processClosed = true;
      exitCode = code;
      if (task.cancelled) return cancel();
      if (!parserDone) {
        if (!child.stdout || child.stdout.readableEnded) worker.postMessage({ type: "end" });
        else child.stdout.once("end", () => {
          if (!settled && !parserDone) worker.postMessage({ type: "end" });
        });
      }
      finish();
    });
    if (task.cancelled) cancel();
  });
}

module.exports = {
  decodeRipgrepText,
  byteOffsetToStringIndex,
  normalizeRipgrepRelativePath,
  parseRipgrepMatch,
  getRipgrepArgs,
  resolveBundledRipgrepPath,
  createRipgrepInvocation,
  isRipgrepUnavailable,
  runRipgrepSearch
};
