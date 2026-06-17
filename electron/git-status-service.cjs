const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");
const { buildSsh2ConnectionConfig } = require("./ssh2-connection.cjs");

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

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Git status timed out."));
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
      if (Number.isInteger(code) && code !== 0) {
        reject(new Error(stderr.trim() || `git status failed with exit code ${code}.`));
        return;
      }
      resolve(stdout);
    });
  });
}

function createGitStatusService({
  terminalManager,
  sessionStore,
  knownHostStore,
  spawn = defaultSpawn,
  clientFactory = createDefaultSshClient
}) {
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

  function getSecret(sshConfig) {
    if (!sshConfig?.encryptedSecret || typeof sessionStore?.decryptSecret !== "function") {
      return undefined;
    }
    return sessionStore.decryptSecret(sshConfig.encryptedSecret);
  }

  function getSshStatus(session) {
    const client = clientFactory();
    const connectionConfig = buildSsh2ConnectionConfig({
      sshConfig: session.sshConfig || {},
      secret: getSecret(session.sshConfig),
      knownHostStore
    });
    const cwd = normalizeWslPath(session.cwd);
    const command = `cd ${shellQuote(cwd)} && git status --porcelain=v1 -z`;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          client.end();
        } catch {
          // Ignore close failures after timeout.
        }
        reject(new Error("Git status timed out."));
      }, STATUS_TIMEOUT_MS);

      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      client.once("ready", () => {
        client.exec(command, (err, stream) => {
          if (err) {
            fail(err);
            return;
          }

          let stdout = "";
          let stderr = "";
          stream.on("data", (data) => {
            stdout += Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
          });
          stream.stderr?.on("data", (data) => {
            stderr += Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
          });
          stream.on("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            client.end();
            if (Number.isInteger(code) && code !== 0) {
              reject(new Error(stderr.trim() || `git status failed with exit code ${code}.`));
              return;
            }
            resolve(stdout);
          });
        });
      });
      client.on("error", fail);
      client.on("keyboard-interactive", (_name, _instructions, _language, prompts, finish) => {
        const secret = connectionConfig.password || connectionConfig.passphrase;
        finish(Array.isArray(prompts) ? prompts.map((prompt) => prompt?.echo ? "" : String(secret || "")) : []);
      });
      client.connect(connectionConfig);
    });
  }

  async function getStatus(sessionId) {
    const session = getSession(sessionId);
    let output;
    if (session.type === "windows") {
      output = await runProcess(spawn, "git", ["status", "--porcelain=v1", "-z"], {
        cwd: normalizeWindowsPath(session.cwd)
      });
    } else if (session.type === "wsl") {
      output = await runProcess(spawn, "wsl.exe", [
        "-d",
        validateWslDistro(session.wslDistro),
        "--cd",
        normalizeWslPath(session.cwd),
        "git",
        "status",
        "--porcelain=v1",
        "-z"
      ]);
    } else {
      output = await getSshStatus(session);
    }

    const files = parsePorcelainStatus(output);
    return {
      cwd: session.cwd,
      clean: files.length === 0,
      files
    };
  }

  return {
    getStatus,
    parsePorcelainStatus,
    getErrorMessage
  };
}

module.exports = {
  STATUS_TIMEOUT_MS,
  createGitStatusService,
  parsePorcelainStatus
};
