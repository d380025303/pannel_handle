const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");
const { createSshSessionRuntime } = require("../ssh/ssh-session-runtime.cjs");

const STATUS_TIMEOUT_MS = 10000;

const STATUS_LABELS = {
  M: "已修改",
  A: "已添加",
  D: "已删除",
  R: "已重命名",
  C: "已复制",
  U: "未合并",
  "?": "未跟踪",
  "!": "已忽略"
};

const BRANCH_FORMAT = "%(refname)%09%(refname:short)%09%(HEAD)%09%(objectname:short)%09%(committerdate:relative)";
const STASH_FORMAT = "%gd%x09%H%x09%cr%x09%gs";

function getStatusCode(xy) {
  const code = String(xy || "").trim().charAt(0) || String(xy || "").trim().charAt(1) || "?";
  return STATUS_LABELS[code] ? code : "?";
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
    const entry = {
      status: code,
      label: STATUS_LABELS[code],
      path: pathName
    };

    if ((code === "R" || code === "C") && parts[index + 1]) {
      entry.oldPath = parts[index + 1];
      index += 1;
    }

    files.push(entry);
  }

  return files;
}

function normalizeWindowsPath(value) {
  const cwd = String(value || "").trim();
  if (!cwd || cwd.includes("\0")) {
    throw new Error("A valid working directory is required.");
  }
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
  if (!/^[\w.-]+$/.test(distro)) {
    throw new Error("A valid WSL distro is required.");
  }
  return distro;
}

function validateRepoPath(value) {
  const repoPath = String(value || "").trim();
  if (!repoPath || repoPath.includes("\0") || path.isAbsolute(repoPath) || repoPath.split(/[\\/]+/).includes("..")) {
    throw new Error("A valid repository-relative path is required.");
  }
  return repoPath.replace(/\\/g, "/");
}

function validateBranchName(value) {
  const branchName = String(value || "").trim();
  if (
    !branchName ||
    branchName.includes("\0") ||
    branchName.startsWith("-") ||
    branchName.includes("..") ||
    branchName.includes("//") ||
    branchName.endsWith("/") ||
    branchName.endsWith(".") ||
    branchName.endsWith(".lock") ||
    !/^[A-Za-z0-9._/-]+$/.test(branchName)
  ) {
    throw new Error("A valid Git branch name is required.");
  }
  return branchName;
}

function validateBranchEntry(value) {
  const kind = value?.kind === "remote" ? "remote" : "local";
  return {
    kind,
    name: validateBranchName(value?.name)
  };
}

function validateStashRef(value) {
  const ref = String(value || "").trim();
  if (!/^stash@\{\d+\}$/.test(ref)) {
    throw new Error("A valid stash reference is required.");
  }
  return ref;
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

function runProcess(spawn, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const allowExitCodes = options.allowExitCodes || [0];

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${options.actionName || "Git command"} timed out.`));
    }, options.timeoutMs || STATUS_TIMEOUT_MS);

    child.stdout?.on("data", (data) => {
      stdout += Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
    });
    child.stderr?.on("data", (data) => {
      stderr += Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
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
      if (Number.isInteger(code) && !allowExitCodes.includes(code)) {
        reject(new Error(stderr.trim() || `${options.actionName || "Git command"} failed with exit code ${code}.`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseHunkHeader(line) {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) return null;
  return {
    oldLine: Number(match[1]),
    newLine: Number(match[2])
  };
}

function pushChangedRows(rows, deletedRows, addedRows) {
  const maxRows = Math.max(deletedRows.length, addedRows.length);
  for (let index = 0; index < maxRows; index += 1) {
    const deletedRow = deletedRows[index];
    const addedRow = addedRows[index];
    if (deletedRow && addedRow) {
      rows.push({
        type: "modify",
        oldLineNumber: deletedRow.lineNumber,
        newLineNumber: addedRow.lineNumber,
        oldText: deletedRow.text,
        newText: addedRow.text
      });
    } else if (deletedRow) {
      rows.push({
        type: "delete",
        oldLineNumber: deletedRow.lineNumber,
        oldText: deletedRow.text
      });
    } else if (addedRow) {
      rows.push({
        type: "add",
        newLineNumber: addedRow.lineNumber,
        newText: addedRow.text
      });
    }
  }
  deletedRows.length = 0;
  addedRows.length = 0;
}

function parseUnifiedDiff(output) {
  const text = String(output || "");
  if (/^Binary files .+ differ$/m.test(text) || /^GIT binary patch$/m.test(text)) {
    return { kind: "binary", rows: [] };
  }

  const rows = [];
  const deletedRows = [];
  const addedRows = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of text.split(/\r?\n/)) {
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
    if (!inHunk) continue;
    if (rawLine === "") continue;
    if (rawLine.startsWith("\\ No newline")) continue;

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
    rows.push({
      type: "context",
      oldLineNumber: oldLine,
      newLineNumber: newLine,
      oldText: textValue,
      newText: textValue
    });
    oldLine += 1;
    newLine += 1;
  }
  pushChangedRows(rows, deletedRows, addedRows);

  return { kind: "text", rows };
}

function parseBranchList(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [refname, shortName, head, commit, relativeTime] = line.split("\t");
      const isRemote = refname.startsWith("refs/remotes/");
      if (!refname || !shortName || (isRemote && /\/HEAD$/.test(refname))) {
        return null;
      }
      return {
        name: shortName,
        kind: isRemote ? "remote" : "local",
        current: head === "*",
        commit: commit || "",
        relativeTime: relativeTime || ""
      };
    })
    .filter(Boolean);
}

function parseStashList(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [ref, commit, relativeTime, ...messageParts] = line.split("\t");
      if (!/^stash@\{\d+\}$/.test(ref || "")) {
        return null;
      }
      return {
        ref,
        commit: commit || "",
        relativeTime: relativeTime || "",
        message: messageParts.join("\t") || ref
      };
    })
    .filter(Boolean);
}

function createGitStatusService({
  terminalManager,
  sessionStore,
  knownHostStore,
  sshSessionRuntime,
  spawn = defaultSpawn,
  clientFactory = createDefaultSshClient
}) {
  const sshRuntime = sshSessionRuntime || createSshSessionRuntime({
    terminalManager,
    sessionStore,
    knownHostStore,
    clientFactory,
    timeoutMs: STATUS_TIMEOUT_MS
  });
  function getSession(sessionId) {
    const session = terminalManager.getSession(sessionId);
    if (!session) {
      throw new Error("Session is not running.");
    }
    if (!["windows", "wsl", "ssh"].includes(session.type)) {
      throw new Error("Git status is only available for Windows, WSL, and SSH sessions.");
    }
    return session;
  }

  function runSshCommand(session, command, options = {}) {
    return sshRuntime.exec(session.id, command, {
      actionName: options.actionName || "Git command",
      allowExitCodes: options.allowExitCodes,
      timeoutMs: STATUS_TIMEOUT_MS
    });
  }

  function getWorkingDirectory(session, cwdOverride) {
    const hasOverride = typeof cwdOverride !== "undefined";
    const candidate = hasOverride ? cwdOverride : (session.gitCwd || session.cwd);
    if (hasOverride && (typeof candidate !== "string" || !candidate.trim())) {
      throw new Error("A valid absolute Git working directory is required.");
    }
    if (session.type === "windows") {
      if (hasOverride && !path.isAbsolute(candidate.trim())) {
        throw new Error("A valid absolute Git working directory is required.");
      }
      return normalizeWindowsPath(candidate);
    }
    return normalizeWslPath(candidate);
  }

  function runGitForSession(session, args, options = {}) {
    const cwd = getWorkingDirectory(session, options.cwd);
    if (session.type === "windows") {
      return runProcess(spawn, "git", args, {
        cwd,
        actionName: options.actionName,
        allowExitCodes: options.allowExitCodes
      });
    }
    if (session.type === "wsl") {
      return runProcess(spawn, "wsl.exe", [
        "-d",
        validateWslDistro(session.wslDistro),
        "--cd",
        cwd,
        "--exec",
        "git",
        ...args
      ], {
        actionName: options.actionName,
        allowExitCodes: options.allowExitCodes
      });
    }

    const command = `cd ${shellQuote(cwd)} && git ${args.map(shellQuote).join(" ")}`;
    return runSshCommand(session, command, options);
  }

  async function getStatus(sessionId, cwdOverride) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session, cwdOverride);
    const output = await runGitForSession(session, ["status", "--porcelain=v1", "-z"], {
      actionName: "Git status",
      cwd
    });
    const files = parsePorcelainStatus(output);
    return {
      cwd,
      clean: files.length === 0,
      files
    };
  }

  async function getDiff(sessionId, file) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session);
    const repoPath = validateRepoPath(file?.path);
    const oldPath = file?.oldPath ? validateRepoPath(file.oldPath) : undefined;
    const isUntracked = file?.status === "?";
    const args = isUntracked
      ? ["diff", "--no-color", "--no-index", "--", "/dev/null", repoPath]
      : ["diff", "--no-color", "--find-renames", "HEAD", "--", repoPath];
    const output = await runGitForSession(session, args, {
      actionName: "Git diff",
      allowExitCodes: isUntracked ? [0, 1] : [0],
      cwd
    });
    const parsed = parseUnifiedDiff(output);

    return {
      cwd,
      path: repoPath,
      oldPath,
      status: file?.status || "M",
      kind: parsed.kind,
      rows: parsed.rows
    };
  }

  async function getBranches(sessionId, cwdOverride) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session, cwdOverride);
    const output = await runGitForSession(session, [
      "for-each-ref",
      `--format=${BRANCH_FORMAT}`,
      "refs/heads",
      "refs/remotes"
    ], {
      actionName: "Git branch list",
      cwd
    });
    return {
      cwd,
      branches: parseBranchList(output)
    };
  }

  async function checkoutBranch(sessionId, branch) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session);
    const target = validateBranchEntry(branch);
    const args = target.kind === "remote"
      ? ["checkout", "--track", target.name]
      : ["checkout", target.name];
    const output = await runGitForSession(session, args, {
      actionName: "Git checkout"
    });
    const [status, branches] = await Promise.all([
      getStatus(sessionId),
      getBranches(sessionId)
    ]);
    return {
      ok: true,
      cwd,
      message: output.trim(),
      status,
      branches
    };
  }

  async function getStashes(sessionId, cwdOverride) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session, cwdOverride);
    const output = await runGitForSession(session, [
      "stash",
      "list",
      `--format=${STASH_FORMAT}`
    ], {
      actionName: "Git stash list",
      cwd
    });
    return {
      cwd,
      stashes: parseStashList(output)
    };
  }

  async function stashChanges(sessionId) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session);
    const output = await runGitForSession(session, ["stash", "push", "-u"], {
      actionName: "Git stash"
    });
    return {
      ok: true,
      cwd,
      message: output.trim()
    };
  }

  async function applyStash(sessionId, ref) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session);
    const stashRef = validateStashRef(ref);
    const output = await runGitForSession(session, ["stash", "apply", stashRef], {
      actionName: "Git stash apply"
    });
    return {
      ok: true,
      cwd,
      message: output.trim()
    };
  }

  async function popStash(sessionId, ref) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session);
    const stashRef = validateStashRef(ref);
    const output = await runGitForSession(session, ["stash", "pop", stashRef], {
      actionName: "Git stash pop"
    });
    return {
      ok: true,
      cwd,
      message: output.trim()
    };
  }

  async function revertFile(sessionId, file) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session);
    const repoPath = validateRepoPath(file?.path);
    const oldPath = file?.oldPath ? validateRepoPath(file.oldPath) : undefined;
    const isUntracked = file?.status === "?";
    const paths = oldPath && oldPath !== repoPath ? [repoPath, oldPath] : [repoPath];
    const args = isUntracked
      ? ["clean", "-f", "--", ...paths]
      : ["restore", "--staged", "--worktree", "--", ...paths];
    const output = await runGitForSession(session, args, {
      actionName: "Git revert file"
    });
    return {
      ok: true,
      cwd,
      message: output.trim()
    };
  }

  async function changeDirectory(sessionId, cwdValue) {
    const session = getSession(sessionId);
    const cwd = getWorkingDirectory(session, cwdValue);
    const [status, branches, stashes] = await Promise.all([
      getStatus(sessionId, cwd),
      getBranches(sessionId, cwd),
      getStashes(sessionId, cwd)
    ]);
    if (typeof terminalManager.updateGitDirectory !== "function") {
      throw new Error("Git working directory persistence is unavailable.");
    }
    const updatedSession = terminalManager.updateGitDirectory(sessionId, cwd);
    return {
      cwd,
      history: updatedSession.gitCwdHistory || [cwd],
      status,
      branches,
      stashes
    };
  }

  return {
    changeDirectory,
    getStatus,
    getDiff,
    getBranches,
    checkoutBranch,
    getStashes,
    stashChanges,
    applyStash,
    popStash,
    revertFile,
    parsePorcelainStatus,
    parseUnifiedDiff,
    getErrorMessage
  };
}

module.exports = {
  STATUS_TIMEOUT_MS,
  createGitStatusService,
  parsePorcelainStatus,
  parseUnifiedDiff,
  parseBranchList,
  parseStashList
};
