const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { DEFAULT_EXCLUDED_DIRS, MAX_TEXT_FILE_SIZE, MAX_TEXT_RESULTS, SEARCH_TIMEOUT_MS } = require("./search-limits.cjs");
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
    const stdoutDecoder = new StringDecoder("utf8");
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
      stdoutBuffer += Buffer.isBuffer(chunk) ? stdoutDecoder.write(chunk) : String(chunk);
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
      stdoutBuffer += stdoutDecoder.end();
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
