const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function appendLimited(current, data, limit) {
  const next = Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
  const currentBytes = Buffer.byteLength(current, "utf-8");
  if (currentBytes >= limit) return { value: current, truncated: true };
  const remaining = limit - currentBytes;
  if (Buffer.byteLength(next, "utf-8") <= remaining) return { value: current + next, truncated: false };
  return { value: current + Buffer.from(next, "utf-8").subarray(0, remaining).toString("utf-8"), truncated: true };
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

function createSshGitExecutor({ sshSessionRuntime }) {
  if (!sshSessionRuntime) throw new Error("SSH runtime is unavailable.");

  async function runShell(sessionId, command, options = {}) {
    if (typeof sshSessionRuntime.execStreaming !== "function") {
      const stdout = await sshSessionRuntime.exec(sessionId, command, {
        actionName: options.actionName,
        allowExitCodes: options.allowExitCodes,
        timeoutMs: options.timeoutMs
      });
      return { stdout, stderr: "", truncated: false };
    }
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const limit = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
    const handle = await sshSessionRuntime.execStreaming(sessionId, command, {
      actionName: options.actionName,
      connectTimeoutMs: options.timeoutMs,
      onStdout(data) {
        const appended = appendLimited(stdout, data, limit);
        stdout = appended.value;
        truncated ||= appended.truncated;
      },
      onStderr(data) {
        const appended = appendLimited(stderr, data, limit);
        stderr = appended.value;
        truncated ||= appended.truncated;
      }
    });
    options.onCancelReady?.(() => handle.cancel());
    const timer = setTimeout(() => handle.cancel(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
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

  function runGit(sessionId, cwd, args, options = {}) {
    const command = `cd ${shellQuote(cwd)} && GIT_TERMINAL_PROMPT=0 git ${args.map(shellQuote).join(" ")}`;
    return runShell(sessionId, command, options);
  }

  function listDirectories(sessionId, root, options = {}) {
    const args = [".", "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-print0"];
    const command = `cd ${shellQuote(root)} && find ${args.map(shellQuote).join(" ")}`;
    return runShell(sessionId, command, options);
  }

  return { listDirectories, runGit, runShell };
}

module.exports = { createSshGitExecutor, shellQuote };
