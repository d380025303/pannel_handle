const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");
const { createSshSessionRuntime } = require("../ssh/ssh-session-runtime.cjs");

const STATUS_TIMEOUT_MS = 10000;
const WRITE_TIMEOUT_MS = 30000;
const NETWORK_TIMEOUT_MS = 120000;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_ROWS = 5000;
const HISTORY_PAGE_SIZE = 30;

const STATUS_CODES = new Set(["M", "A", "D", "R", "C", "U", "T", "?", "!"]);
const BRANCH_FORMAT = "%(refname)%09%(refname:short)%09%(HEAD)%09%(objectname:short)%09%(committerdate:relative)";
const STASH_FORMAT = "%gd%x09%H%x09%cr%x09%gs";
const HISTORY_FORMAT = "%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1e";

function getStatusCode(xy) {
  const value = String(xy || "");
  const candidates = [value.charAt(0), value.charAt(1)];
  return candidates.find((candidate) => STATUS_CODES.has(candidate) && candidate !== " ") || "?";
}

function createStatusEntry({ xy, pathName, oldPath, conflicted = false }) {
  const indexStatus = xy?.charAt(0) || " ";
  const worktreeStatus = xy?.charAt(1) || " ";
  const status = conflicted ? "U" : getStatusCode(xy);
  return {
    status,
    label: status,
    indexStatus,
    worktreeStatus,
    conflicted,
    path: pathName,
    ...(oldPath ? { oldPath } : {})
  };
}

function parsePorcelainStatus(output) {
  const parts = String(output || "").split("\0").filter(Boolean);
  const files = [];

  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    const xy = record.slice(0, 2);
    const pathName = record.slice(3);
    if (!pathName) continue;
    const code = getStatusCode(xy);
    const oldPath = (code === "R" || code === "C") && parts[index + 1]
      ? parts[index += 1]
      : undefined;
    files.push(createStatusEntry({ xy, pathName, oldPath, conflicted: xy.includes("U") }));
  }

  return files;
}

function parsePorcelainV2(output) {
  const records = String(output || "").split("\0").filter(Boolean);
  const files = [];
  const branch = {
    name: "",
    oid: "",
    detached: false,
    unborn: false,
    upstream: undefined,
    ahead: 0,
    behind: 0
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice(13).trim();
      branch.unborn = oid === "(initial)";
      branch.oid = branch.unborn ? "" : oid;
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      const name = record.slice(14).trim();
      branch.detached = name === "(detached)";
      branch.name = branch.detached ? "" : name;
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      const upstreamName = record.slice(18).trim();
      const slash = upstreamName.indexOf("/");
      branch.upstream = {
        name: upstreamName,
        remote: slash > 0 ? upstreamName.slice(0, slash) : "",
        branch: slash > 0 ? upstreamName.slice(slash + 1) : upstreamName
      };
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /\+(\d+)\s+-(\d+)/.exec(record);
      if (match) {
        branch.ahead = Number(match[1]);
        branch.behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith("1 ")) {
      const fields = record.split(" ");
      const xy = fields[1] || "  ";
      const pathName = fields.slice(8).join(" ");
      if (pathName) files.push(createStatusEntry({ xy, pathName, conflicted: xy.includes("U") }));
      continue;
    }
    if (record.startsWith("2 ")) {
      const fields = record.split(" ");
      const xy = fields[1] || "  ";
      const pathName = fields.slice(9).join(" ");
      const oldPath = records[index + 1] || undefined;
      if (oldPath) index += 1;
      if (pathName) files.push(createStatusEntry({ xy, pathName, oldPath, conflicted: xy.includes("U") }));
      continue;
    }
    if (record.startsWith("u ")) {
      const fields = record.split(" ");
      const xy = fields[1] || "UU";
      const pathName = fields.slice(10).join(" ");
      if (pathName) files.push(createStatusEntry({ xy, pathName, conflicted: true }));
      continue;
    }
    if (record.startsWith("? ") || record.startsWith("! ")) {
      const code = record.charAt(0);
      files.push(createStatusEntry({ xy: `${code}${code}`, pathName: record.slice(2) }));
    }
  }

  return { branch, files };
}

function normalizeWindowsPath(value) {
  const cwd = String(value || "").trim();
  if (!cwd || cwd.includes("\0")) throw new Error("A valid working directory is required.");
  return path.resolve(cwd);
}

function normalizeWslPath(value) {
  const cwd = String(value || "").trim();
  if (!cwd || cwd === "~" || cwd.includes("\0") || !cwd.startsWith("/")) {
    throw new Error("A valid absolute WSL working directory is required.");
  }
  return cwd.replace(/\/+$/, "") || "/";
}

function validateWslDistro(value) {
  const distro = String(value || "").trim();
  if (!/^[\w.-]+$/.test(distro)) throw new Error("A valid WSL distro is required.");
  return distro;
}

function validateRepoPath(value) {
  const repoPath = String(value || "").trim();
  if (!repoPath || repoPath.includes("\0") || path.isAbsolute(repoPath) || repoPath.split(/[\\/]+/).includes("..")) {
    throw new Error("A valid repository-relative path is required.");
  }
  return repoPath.replace(/\\/g, "/");
}

function validateRepoPaths(values) {
  const paths = Array.isArray(values) ? values.map(validateRepoPath) : [];
  if (!paths.length) throw new Error("At least one repository path is required.");
  return [...new Set(paths)];
}

function validateBranchNameInput(value) {
  const branchName = String(value || "").trim();
  if (!branchName || branchName.includes("\0") || branchName.startsWith("-")) {
    throw new Error("A valid Git branch name is required.");
  }
  return branchName;
}

function validateBranchEntry(value) {
  return {
    kind: value?.kind === "remote" ? "remote" : "local",
    name: validateBranchNameInput(value?.name)
  };
}

function validateStashRef(value) {
  const ref = String(value || "").trim();
  if (!/^stash@\{\d+\}$/.test(ref)) throw new Error("A valid stash reference is required.");
  return ref;
}

function validateRemoteName(value, remotes) {
  const remote = String(value || "").trim();
  if (!remote || !remotes.includes(remote)) throw new Error("Select an existing Git remote.");
  return remote;
}

function validateCommitOid(value) {
  const oid = String(value || "").trim();
  if (!/^[0-9a-f]{7,64}$/i.test(oid)) throw new Error("A valid commit id is required.");
  return oid;
}

function validateOperationId(value) {
  const operationId = String(value || "").trim();
  if (!operationId || !/^[A-Za-z0-9._:-]{1,120}$/.test(operationId)) {
    throw new Error("A valid Git operation id is required.");
  }
  return operationId;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function getErrorMessage(err) {
  return err instanceof Error ? err.message : String(err || "Unknown error");
}

function createDefaultSshClient() {
  const { Client } = require("ssh2");
  return new Client();
}

function createCommandError(actionName, code, stdout, stderr, canceled = false) {
  const detail = String(stderr || stdout || "").trim();
  const error = new Error(detail || (canceled ? `${actionName} canceled.` : `${actionName} failed with exit code ${code}.`));
  error.code = code;
  error.stdout = stdout;
  error.stderr = stderr;
  error.canceled = canceled;
  return error;
}

function appendLimited(current, data, limit) {
  const next = Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
  const currentBytes = Buffer.byteLength(current, "utf-8");
  if (currentBytes >= limit) return { value: current, truncated: true };
  const remaining = limit - currentBytes;
  if (Buffer.byteLength(next, "utf-8") <= remaining) return { value: current + next, truncated: false };
  return { value: current + Buffer.from(next, "utf-8").subarray(0, remaining).toString("utf-8"), truncated: true };
}

function runProcess(spawn, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: options.env
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let canceled = false;
    const allowExitCodes = options.allowExitCodes || [0];
    const outputLimit = options.maxOutputBytes || MAX_COMMAND_OUTPUT_BYTES;

    options.onCancelReady?.(() => {
      if (settled) return;
      canceled = true;
      try { child.kill(); } catch { /* best effort */ }
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* best effort */ }
      reject(createCommandError(options.actionName || "Git command", "TIMEOUT", stdout, `${options.actionName || "Git command"} timed out.`));
    }, options.timeoutMs || STATUS_TIMEOUT_MS);

    child.stdout?.on("data", (data) => {
      const appended = appendLimited(stdout, data, outputLimit);
      stdout = appended.value;
      truncated = truncated || appended.truncated;
    });
    child.stderr?.on("data", (data) => {
      const appended = appendLimited(stderr, data, outputLimit);
      stderr = appended.value;
      truncated = truncated || appended.truncated;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (canceled) {
        reject(createCommandError(options.actionName || "Git command", code, stdout, stderr, true));
        return;
      }
      if (Number.isInteger(code) && !allowExitCodes.includes(code)) {
        reject(createCommandError(options.actionName || "Git command", code, stdout, stderr));
        return;
      }
      resolve({ stdout, stderr, truncated });
    });
  });
}

function parseHunkHeader(line) {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) return null;
  return { oldLine: Number(match[1]), newLine: Number(match[2]) };
}

function pushChangedRows(rows, deletedRows, addedRows) {
  const maxRows = Math.max(deletedRows.length, addedRows.length);
  for (let index = 0; index < maxRows; index += 1) {
    const deletedRow = deletedRows[index];
    const addedRow = addedRows[index];
    if (deletedRow && addedRow) {
      rows.push({ type: "modify", oldLineNumber: deletedRow.lineNumber, newLineNumber: addedRow.lineNumber, oldText: deletedRow.text, newText: addedRow.text });
    } else if (deletedRow) {
      rows.push({ type: "delete", oldLineNumber: deletedRow.lineNumber, oldText: deletedRow.text });
    } else if (addedRow) {
      rows.push({ type: "add", newLineNumber: addedRow.lineNumber, newText: addedRow.text });
    }
  }
  deletedRows.length = 0;
  addedRows.length = 0;
}

function parseUnifiedDiff(output, maxRows = MAX_DIFF_ROWS) {
  const text = String(output || "");
  if (/^Binary files .+ differ$/m.test(text) || /^GIT binary patch$/m.test(text)) {
    return { kind: "binary", rows: [], truncated: false };
  }

  const rows = [];
  const deletedRows = [];
  const addedRows = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let truncated = false;

  for (const rawLine of text.split(/\r?\n/)) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    if (rawLine.startsWith("@@ ")) {
      pushChangedRows(rows, deletedRows, addedRows);
      const hunk = parseHunkHeader(rawLine);
      if (hunk) {
        oldLine = hunk.oldLine;
        newLine = hunk.newLine;
        inHunk = true;
      }
      continue;
    }
    if (!inHunk || rawLine === "" || rawLine.startsWith("\\ No newline")) continue;
    if (rawLine.startsWith("-")) {
      deletedRows.push({ lineNumber: oldLine, text: rawLine.slice(1) });
      oldLine += 1;
      continue;
    }
    if (rawLine.startsWith("+")) {
      addedRows.push({ lineNumber: newLine, text: rawLine.slice(1) });
      newLine += 1;
      continue;
    }
    pushChangedRows(rows, deletedRows, addedRows);
    const textValue = rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine;
    rows.push({ type: "context", oldLineNumber: oldLine, newLineNumber: newLine, oldText: textValue, newText: textValue });
    oldLine += 1;
    newLine += 1;
  }
  pushChangedRows(rows, deletedRows, addedRows);
  if (rows.length > maxRows) {
    rows.length = maxRows;
    truncated = true;
  }
  return { kind: "text", rows, truncated };
}

function parseBranchList(output) {
  return String(output || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).map((line) => {
    const [refname, shortName, head, commit, relativeTime] = line.split("\t");
    const isRemote = refname?.startsWith("refs/remotes/");
    if (!refname || !shortName || (isRemote && /\/HEAD$/.test(refname))) return null;
    return { name: shortName, kind: isRemote ? "remote" : "local", current: head === "*", commit: commit || "", relativeTime: relativeTime || "" };
  }).filter(Boolean);
}

function parseStashList(output) {
  return String(output || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).map((line) => {
    const [ref, commit, relativeTime, ...messageParts] = line.split("\t");
    if (!/^stash@\{\d+\}$/.test(ref || "")) return null;
    return { ref, commit: commit || "", relativeTime: relativeTime || "", message: messageParts.join("\t") || ref };
  }).filter(Boolean);
}

function parseHistory(output) {
  return String(output || "").split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
    const [oid, shortOid, authorName, authorEmail, authoredAt, subject, decorations] = record.split("\x1f");
    return {
      oid,
      shortOid,
      authorName,
      authorEmail,
      authoredAt: Number(authoredAt) * 1000,
      subject,
      decorations: String(decorations || "").split(",").map((item) => item.trim()).filter(Boolean)
    };
  });
}

function createGitStatusService({
  terminalManager,
  sessionStore,
  knownHostStore,
  sshSessionRuntime,
  spawn = defaultSpawn,
  clientFactory = createDefaultSshClient
}) {
  const sshRuntime = sshSessionRuntime || createSshSessionRuntime({ terminalManager, sessionStore, knownHostStore, clientFactory, timeoutMs: STATUS_TIMEOUT_MS });
  const activeOperations = new Map();
  const activeRepositoryOperations = new Map();

  function getSession(sessionId) {
    const session = terminalManager.getSession(sessionId);
    if (!session) throw new Error("Session is not running.");
    if (!["windows", "wsl", "ssh"].includes(session.type)) {
      throw new Error("Git is only available for Windows, WSL, and SSH sessions.");
    }
    return session;
  }

  function getWorkingDirectory(session, cwdOverride) {
    const hasOverride = typeof cwdOverride !== "undefined";
    const candidate = hasOverride ? cwdOverride : (session.gitCwd || session.cwd);
    if (hasOverride && (typeof candidate !== "string" || !candidate.trim())) {
      throw new Error("A valid absolute Git working directory is required.");
    }
    if (session.type === "windows") {
      if (hasOverride && !path.isAbsolute(candidate.trim())) throw new Error("A valid absolute Git working directory is required.");
      return normalizeWindowsPath(candidate);
    }
    return normalizeWslPath(candidate);
  }

  async function runSshCommand(session, args, options = {}) {
    const cwd = getWorkingDirectory(session, options.cwd);
    const command = `cd ${shellQuote(cwd)} && GIT_TERMINAL_PROMPT=0 git ${args.map(shellQuote).join(" ")}`;
    if (typeof sshRuntime.execStreaming !== "function") {
      const stdout = await sshRuntime.exec(session.id, command, {
        actionName: options.actionName,
        allowExitCodes: options.allowExitCodes,
        timeoutMs: options.timeoutMs
      });
      return { stdout, stderr: "", truncated: false };
    }
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const limit = options.maxOutputBytes || MAX_COMMAND_OUTPUT_BYTES;
    const handle = await sshRuntime.execStreaming(session.id, command, {
      actionName: options.actionName,
      connectTimeoutMs: options.timeoutMs,
      onStdout(data) {
        const appended = appendLimited(stdout, data, limit);
        stdout = appended.value;
        truncated = truncated || appended.truncated;
      },
      onStderr(data) {
        const appended = appendLimited(stderr, data, limit);
        stderr = appended.value;
        truncated = truncated || appended.truncated;
      }
    });
    options.onCancelReady?.(() => handle.cancel());
    const timer = setTimeout(() => handle.cancel(), options.timeoutMs || STATUS_TIMEOUT_MS);
    let result;
    try {
      result = await handle.promise;
    } finally {
      clearTimeout(timer);
    }
    const allowExitCodes = options.allowExitCodes || [0];
    if (!allowExitCodes.includes(result.exitCode)) {
      throw createCommandError(options.actionName || "Git command", result.exitCode, stdout, stderr, result.signal === "TERM");
    }
    return { stdout, stderr, truncated };
  }

  function runGitForSession(session, args, options = {}) {
    const cwd = getWorkingDirectory(session, options.cwd);
    if (session.type === "ssh") return runSshCommand(session, args, options);
    const environment = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (session.type === "windows") {
      return runProcess(spawn, "git", args, { ...options, cwd, env: environment });
    }
    return runProcess(spawn, "wsl.exe", [
      "-d",
      validateWslDistro(session.wslDistro),
      "--cd",
      cwd,
      "--exec",
      "env",
      "GIT_TERMINAL_PROMPT=0",
      "git",
      ...args
    ], { ...options, env: environment });
  }

  async function hasHead(session, cwd) {
    const result = await runGitForSession(session, ["rev-parse", "--verify", "HEAD"], {
      actionName: "Git HEAD check",
      allowExitCodes: [0, 128],
      cwd
    });
    return Boolean(result.stdout.trim());
  }

  async function getOperationStateForSession(session, cwd) {
    const refs = [
      ["merge", "MERGE_HEAD"],
      ["rebase", "REBASE_HEAD"],
      ["cherry-pick", "CHERRY_PICK_HEAD"],
      ["revert", "REVERT_HEAD"]
    ];
    for (const [kind, ref] of refs) {
      const result = await runGitForSession(session, ["rev-parse", "-q", "--verify", ref], {
        actionName: "Git operation state",
        allowExitCodes: [0, 1],
        cwd
      });
      if (result.stdout.trim()) return kind;
    }
    return null;
  }

  async function getStatus(sessionId, cwdOverride) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session, cwdOverride);
    const result = await runGitForSession(session, ["status", "--porcelain=v2", "--branch", "-z"], {
      actionName: "Git status",
      cwd
    });
    if (result.truncated) throw new Error("Git status output is too large to display safely.");
    const parsed = parsePorcelainV2(result.stdout);
    return { cwd, clean: parsed.files.length === 0, files: parsed.files, branch: parsed.branch };
  }

  async function getBranches(sessionId, cwdOverride) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session, cwdOverride);
    const result = await runGitForSession(session, ["for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads", "refs/remotes"], {
      actionName: "Git branch list",
      cwd
    });
    return { cwd, branches: parseBranchList(result.stdout) };
  }

  async function getRemotes(sessionId, cwdOverride) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session, cwdOverride);
    const result = await runGitForSession(session, ["remote"], { actionName: "Git remote list", cwd });
    return { cwd, remotes: result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) };
  }

  async function getStashes(sessionId, cwdOverride) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session, cwdOverride);
    const result = await runGitForSession(session, ["stash", "list", `--format=${STASH_FORMAT}`], { actionName: "Git stash list", cwd });
    return { cwd, stashes: parseStashList(result.stdout) };
  }

  async function getSnapshot(sessionId, cwdOverride) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session, cwdOverride);
    const [statusResult, branchesResult, remotesResult, stashesResult, operationResult] = await Promise.allSettled([
      getStatus(sessionId, cwd),
      getBranches(sessionId, cwd),
      getRemotes(sessionId, cwd),
      getStashes(sessionId, cwd),
      getOperationStateForSession(session, cwd)
    ]);
    if (statusResult.status === "rejected") throw statusResult.reason;
    return {
      cwd,
      status: statusResult.value,
      branches: branchesResult.status === "fulfilled" ? branchesResult.value : { cwd, branches: [], error: getErrorMessage(branchesResult.reason) },
      remotes: remotesResult.status === "fulfilled" ? remotesResult.value : { cwd, remotes: [], error: getErrorMessage(remotesResult.reason) },
      stashes: stashesResult.status === "fulfilled" ? stashesResult.value : { cwd, stashes: [], error: getErrorMessage(stashesResult.reason) },
      operationState: operationResult.status === "fulfilled" ? operationResult.value : null,
      operationStateError: operationResult.status === "rejected" ? getErrorMessage(operationResult.reason) : undefined
    };
  }

  async function discoverRepository(sessionId) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session, session.cwd);
    const result = await runGitForSession(session, ["rev-parse", "--show-toplevel"], { actionName: "Git repository discovery", cwd });
    return { cwd: result.stdout.trim() };
  }

  async function changeDirectory(sessionId, cwdValue) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session, cwdValue);
    const snapshot = await getSnapshot(sessionId, cwd);
    if (typeof terminalManager.updateGitDirectory !== "function") throw new Error("Git working directory persistence is unavailable.");
    const updatedSession = terminalManager.updateGitDirectory(sessionId, cwd);
    return {
      cwd,
      history: updatedSession.gitCwdHistory || [cwd],
      snapshot,
      status: snapshot.status,
      branches: snapshot.branches,
      stashes: snapshot.stashes
    };
  }

  async function getDiff(sessionId, request) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session);
    const scope = request?.scope || "combined";
    const repoPath = request?.path ? validateRepoPath(request.path) : undefined;
    const oldPath = request?.oldPath ? validateRepoPath(request.oldPath) : undefined;
    let args;
    let allowExitCodes = [0];
    if (scope === "working") {
      const isUntracked = request?.indexStatus === "?" || request?.status === "?";
      args = isUntracked
        ? ["diff", "--no-color", "--no-index", "--", "/dev/null", repoPath]
        : ["diff", "--no-color", "--find-renames", "--", repoPath];
      if (isUntracked) allowExitCodes = [0, 1];
    } else if (scope === "staged") {
      args = ["diff", "--cached", "--no-color", "--find-renames", "--", repoPath];
    } else if (scope === "commit") {
      const oid = validateCommitOid(request?.revision);
      args = ["show", "--format=", "--no-ext-diff", "--no-color", "--find-renames", oid, ...(repoPath ? ["--", repoPath] : [])];
    } else if (scope === "stash") {
      args = ["stash", "show", "-p", "--include-untracked", "--no-color", validateStashRef(request?.revision)];
    } else {
      if (!repoPath) throw new Error("A repository path is required for this diff.");
      const isUntracked = request?.status === "?";
      args = isUntracked
        ? ["diff", "--no-color", "--no-index", "--", "/dev/null", repoPath]
        : ["diff", "--no-color", "--find-renames", "HEAD", "--", repoPath];
      if (isUntracked) allowExitCodes = [0, 1];
    }
    if ((scope === "working" || scope === "staged") && !repoPath) throw new Error("A repository path is required for this diff.");
    const result = await runGitForSession(session, args, {
      actionName: "Git diff",
      allowExitCodes,
      cwd,
      maxOutputBytes: MAX_DIFF_OUTPUT_BYTES
    });
    const parsed = parseUnifiedDiff(result.stdout);
    return {
      cwd,
      path: repoPath || "",
      oldPath,
      status: request?.status || "M",
      scope,
      kind: parsed.kind,
      rows: parsed.rows,
      truncated: result.truncated || parsed.truncated,
      capturedBytes: Buffer.byteLength(result.stdout, "utf-8")
    };
  }

  async function getHistory(sessionId, options = {}) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session);
    const skip = Math.max(0, Number(options.skip) || 0);
    if (!await hasHead(session, cwd)) return { cwd, commits: [], hasMore: false, nextSkip: skip };
    const result = await runGitForSession(session, [
      "log",
      "HEAD",
      "--date-order",
      `--max-count=${HISTORY_PAGE_SIZE + 1}`,
      `--skip=${skip}`,
      `--format=${HISTORY_FORMAT}`
    ], { actionName: "Git history", cwd });
    const parsed = parseHistory(result.stdout);
    const hasMore = parsed.length > HISTORY_PAGE_SIZE;
    const commits = parsed.slice(0, HISTORY_PAGE_SIZE);
    return { cwd, commits, hasMore, nextSkip: skip + commits.length };
  }

  function cancelOperation(operationId) {
    const id = String(operationId || "");
    const operation = activeOperations.get(id);
    if (!operation) return false;
    operation.cancelRequested = true;
    operation.cancel?.();
    return true;
  }

  function shutdown() {
    for (const operation of activeOperations.values()) {
      operation.cancelRequested = true;
      operation.cancel?.();
    }
    activeOperations.clear();
    activeRepositoryOperations.clear();
  }

  async function runOperation(sessionId, operationIdValue, actionName, args, options = {}) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session);
    const operationId = validateOperationId(operationIdValue || `legacy-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const repositoryKey = `${session.id}:${cwd}`;
    if (activeRepositoryOperations.has(repositoryKey)) {
      return { ok: false, operationId, cwd, message: "Another Git write operation is already running for this repository." };
    }
    const operation = { operationId, sessionId, cwd, actionName, cancelRequested: false, cancel: undefined };
    activeOperations.set(operationId, operation);
    activeRepositoryOperations.set(repositoryKey, operationId);
    try {
      const result = await runGitForSession(session, args, {
        actionName,
        cwd,
        timeoutMs: options.timeoutMs || WRITE_TIMEOUT_MS,
        allowExitCodes: options.allowExitCodes,
        onCancelReady(cancel) {
          operation.cancel = cancel;
          if (operation.cancelRequested) cancel();
        }
      });
      return {
        ok: true,
        operationId,
        cwd,
        message: result.stdout.trim() || result.stderr.trim() || `${actionName} completed.`,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated
      };
    } catch (err) {
      return {
        ok: false,
        operationId,
        cwd,
        message: getErrorMessage(err),
        stdout: err?.stdout || "",
        stderr: err?.stderr || "",
        canceled: Boolean(err?.canceled || operation.cancelRequested)
      };
    } finally {
      activeOperations.delete(operationId);
      if (activeRepositoryOperations.get(repositoryKey) === operationId) activeRepositoryOperations.delete(repositoryKey);
    }
  }

  async function stageFiles(sessionId, paths, operationId) {
    return runOperation(sessionId, operationId, "Git stage", ["add", "-A", "--", ...validateRepoPaths(paths)]);
  }

  async function stageAll(sessionId, operationId) {
    return runOperation(sessionId, operationId, "Git stage all", ["add", "-A"]);
  }

  async function unstageFiles(sessionId, paths, operationId) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session);
    const safePaths = validateRepoPaths(paths);
    const args = await hasHead(session, cwd)
      ? ["restore", "--staged", "--", ...safePaths]
      : ["rm", "--cached", "-r", "--ignore-unmatch", "--", ...safePaths];
    return runOperation(sessionId, operationId, "Git unstage", args);
  }

  async function unstageAll(sessionId, operationId) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session);
    const args = await hasHead(session, cwd)
      ? ["restore", "--staged", ":/"]
      : ["rm", "--cached", "-r", "--ignore-unmatch", "."];
    return runOperation(sessionId, operationId, "Git unstage all", args);
  }

  async function discardWorkingTree(sessionId, request, operationId) {
    const paths = validateRepoPaths([request?.path, ...(request?.oldPath ? [request.oldPath] : [])]);
    const isUntracked = request?.indexStatus === "?" || request?.status === "?";
    const args = isUntracked ? ["clean", "-f", "--", ...paths] : ["restore", "--worktree", "--", ...paths];
    return runOperation(sessionId, operationId, "Git discard working tree changes", args);
  }

  async function commit(sessionId, message, operationId) {
    const subject = String(message?.subject || "").trim();
    const body = String(message?.body || "").trim();
    if (!subject) return { ok: false, operationId, message: "A commit subject is required." };
    if (Buffer.byteLength(`${subject}\n${body}`, "utf-8") > 64 * 1024) {
      return { ok: false, operationId, message: "The commit message is too large." };
    }
    const snapshot = await getSnapshot(sessionId);
    if (snapshot.operationState) {
      return { ok: false, operationId, cwd: snapshot.cwd, message: `Finish or abort the current ${snapshot.operationState} operation in the terminal first.` };
    }
    const hasStaged = snapshot.status.files.some((file) => ![" ", ".", "?", "!"].includes(file.indexStatus));
    if (!hasStaged) return { ok: false, operationId, cwd: snapshot.cwd, message: "Stage at least one change before committing." };
    return runOperation(sessionId, operationId, "Git commit", ["commit", "-m", subject, ...(body ? ["-m", body] : [])]);
  }

  async function checkoutBranch(sessionId, branch, operationId) {
    const target = validateBranchEntry(branch);
    const snapshot = await getSnapshot(sessionId);
    if (snapshot.operationState) {
      return { ok: false, operationId, cwd: snapshot.cwd, message: `Finish or abort the current ${snapshot.operationState} operation first.` };
    }
    const branches = snapshot.branches.branches;
    if (!branches.some((candidate) => candidate.kind === target.kind && candidate.name === target.name)) {
      return { ok: false, operationId, cwd: snapshot.cwd, message: "The selected branch no longer exists." };
    }
    const args = target.kind === "remote" ? ["checkout", "--track", target.name] : ["checkout", target.name];
    return runOperation(sessionId, operationId, "Git checkout", args);
  }

  async function createBranch(sessionId, branchNameValue, operationId) {
    const branchName = validateBranchNameInput(branchNameValue);
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session);
    const snapshot = await getSnapshot(sessionId);
    if (snapshot.operationState) {
      return { ok: false, operationId, cwd: snapshot.cwd, message: `Finish or abort the current ${snapshot.operationState} operation first.` };
    }
    try {
      await runGitForSession(session, ["check-ref-format", "--branch", branchName], { actionName: "Git branch validation", cwd });
    } catch (err) {
      return { ok: false, operationId, cwd, message: getErrorMessage(err) };
    }
    return runOperation(sessionId, operationId, "Git create branch", ["checkout", "-b", branchName]);
  }

  async function fetchRemote(sessionId, remoteValue, operationId) {
    const snapshot = await getSnapshot(sessionId);
    if (snapshot.operationState) {
      return { ok: false, operationId, cwd: snapshot.cwd, message: `Finish or abort the current ${snapshot.operationState} operation first.` };
    }
    const remote = validateRemoteName(remoteValue, snapshot.remotes.remotes);
    return runOperation(sessionId, operationId, "Git fetch", ["fetch", "--prune", remote], { timeoutMs: NETWORK_TIMEOUT_MS });
  }

  async function pullBranch(sessionId, operationId) {
    const snapshot = await getSnapshot(sessionId);
    if (snapshot.status.branch.detached || !snapshot.status.branch.upstream) {
      return { ok: false, operationId, cwd: snapshot.cwd, message: "The current branch has no upstream to pull from." };
    }
    if (snapshot.operationState) {
      return { ok: false, operationId, cwd: snapshot.cwd, message: `Finish or abort the current ${snapshot.operationState} operation first.` };
    }
    return runOperation(sessionId, operationId, "Git pull", ["pull", "--ff-only"], { timeoutMs: NETWORK_TIMEOUT_MS });
  }

  async function pushBranch(sessionId, remoteValue, operationId) {
    const snapshot = await getSnapshot(sessionId);
    const branch = snapshot.status.branch;
    if (branch.detached || branch.unborn || !branch.name) {
      return { ok: false, operationId, cwd: snapshot.cwd, message: "Create a branch before pushing." };
    }
    if (snapshot.operationState) {
      return { ok: false, operationId, cwd: snapshot.cwd, message: `Finish or abort the current ${snapshot.operationState} operation first.` };
    }
    if (branch.upstream) return runOperation(sessionId, operationId, "Git push", ["push"], { timeoutMs: NETWORK_TIMEOUT_MS });
    const remote = validateRemoteName(remoteValue, snapshot.remotes.remotes);
    return runOperation(sessionId, operationId, "Git push", ["push", "--set-upstream", remote, branch.name], { timeoutMs: NETWORK_TIMEOUT_MS });
  }

  async function stashChanges(sessionId, messageValue, operationId) {
    const message = typeof messageValue === "string" ? messageValue.trim() : "";
    return runOperation(sessionId, operationId, "Git stash", ["stash", "push", "-u", ...(message ? ["-m", message] : [])]);
  }

  function applyStash(sessionId, ref, operationId) {
    return runOperation(sessionId, operationId, "Git stash apply", ["stash", "apply", "--index", validateStashRef(ref)]);
  }

  function popStash(sessionId, ref, operationId) {
    return runOperation(sessionId, operationId, "Git stash pop", ["stash", "pop", "--index", validateStashRef(ref)]);
  }

  function dropStash(sessionId, ref, operationId) {
    return runOperation(sessionId, operationId, "Git stash drop", ["stash", "drop", validateStashRef(ref)]);
  }

  function revertFile(sessionId, file, operationId) {
    return discardWorkingTree(sessionId, file, operationId);
  }

  return {
    changeDirectory,
    discoverRepository,
    getSnapshot,
    getStatus,
    getDiff,
    getBranches,
    getRemotes,
    getStashes,
    getHistory,
    stageFiles,
    stageAll,
    unstageFiles,
    unstageAll,
    discardWorkingTree,
    commit,
    checkoutBranch,
    createBranch,
    fetchRemote,
    pullBranch,
    pushBranch,
    stashChanges,
    applyStash,
    popStash,
    dropStash,
    revertFile,
    cancelOperation,
    shutdown,
    parsePorcelainStatus,
    parsePorcelainV2,
    parseUnifiedDiff,
    getErrorMessage
  };
}

module.exports = {
  STATUS_TIMEOUT_MS,
  WRITE_TIMEOUT_MS,
  NETWORK_TIMEOUT_MS,
  MAX_DIFF_OUTPUT_BYTES,
  MAX_DIFF_ROWS,
  HISTORY_PAGE_SIZE,
  createGitStatusService,
  parsePorcelainStatus,
  parsePorcelainV2,
  parseUnifiedDiff,
  parseBranchList,
  parseStashList,
  parseHistory
};
