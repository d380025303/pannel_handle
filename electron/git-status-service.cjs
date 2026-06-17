const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");
const { createSshSessionRuntime } = require("./ssh-session-runtime.cjs");

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

  function runGitForSession(session, args, options = {}) {
    if (session.type === "windows") {
      return runProcess(spawn, "git", args, {
        cwd: normalizeWindowsPath(session.cwd),
        actionName: options.actionName,
        allowExitCodes: options.allowExitCodes
      });
    }
    if (session.type === "wsl") {
      return runProcess(spawn, "wsl.exe", [
        "-d",
        validateWslDistro(session.wslDistro),
        "--cd",
        normalizeWslPath(session.cwd),
        "git",
        ...args
      ], {
        actionName: options.actionName,
        allowExitCodes: options.allowExitCodes
      });
    }

    const cwd = normalizeWslPath(session.cwd);
    const command = `cd ${shellQuote(cwd)} && git ${args.map(shellQuote).join(" ")}`;
    return runSshCommand(session, command, options);
  }

  async function getStatus(sessionId) {
    const session = getSession(sessionId);
    const output = await runGitForSession(session, ["status", "--porcelain=v1", "-z"], {
      actionName: "Git status"
    });
    const files = parsePorcelainStatus(output);
    return {
      cwd: session.cwd,
      clean: files.length === 0,
      files
    };
  }

  async function getDiff(sessionId, file) {
    const session = getSession(sessionId);
    const repoPath = validateRepoPath(file?.path);
    const oldPath = file?.oldPath ? validateRepoPath(file.oldPath) : undefined;
    const isUntracked = file?.status === "?";
    const args = isUntracked
      ? ["diff", "--no-color", "--no-index", "--", "/dev/null", repoPath]
      : ["diff", "--no-color", "--find-renames", "HEAD", "--", repoPath];
    const output = await runGitForSession(session, args, {
      actionName: "Git diff",
      allowExitCodes: isUntracked ? [0, 1] : [0]
    });
    const parsed = parseUnifiedDiff(output);

    return {
      cwd: session.cwd,
      path: repoPath,
      oldPath,
      status: file?.status || "M",
      kind: parsed.kind,
      rows: parsed.rows
    };
  }

  return {
    getStatus,
    getDiff,
    parsePorcelainStatus,
    parseUnifiedDiff,
    getErrorMessage
  };
}

module.exports = {
  STATUS_TIMEOUT_MS,
  createGitStatusService,
  parsePorcelainStatus,
  parseUnifiedDiff
};
