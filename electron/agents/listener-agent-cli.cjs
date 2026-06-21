const { spawn: defaultSpawn, spawnSync: defaultSpawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const COMMANDS = { claude: "claude", codex: "codex", opencode: "opencode", qoder: "qoderclicn" };

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildInvocation(provider, permission, prompt, session) {
  const writable = permission === "write";
  if (provider === "claude") {
    return { command: "claude", args: ["--print", "--output-format", "text", "--permission-mode", writable ? "acceptEdits" : "plan"], promptArgument: prompt };
  }
  if (provider === "codex") {
    return { command: "codex", args: ["--ask-for-approval", "never", "exec", "--sandbox", writable ? "workspace-write" : "read-only", "-"] , stdin: prompt };
  }
  if (provider === "opencode") {
    return { command: "opencode", args: ["run", "--agent", writable ? "build" : "plan"], promptArgument: prompt };
  }
  if (provider === "qoder") {
    const tools = writable ? ["Read", "Glob", "Grep", "Edit", "Write"] : ["Read", "Glob", "Grep"];
    return { command: "qoderclicn", args: ["--print", "--permission-mode", writable ? "accept_edits" : "dont_ask", "--tools", ...tools, "--"], promptArgument: prompt };
  }
  throw new Error(`Unsupported listener Agent provider: ${provider}.`);
}

function createListenerAgentCli({ spawn = defaultSpawn, spawnSync = defaultSpawnSync, sshSessionRuntime }) {
  function assertAvailable(session, provider) {
    const command = COMMANDS[provider];
    if (session.type === "ssh") return;
    const result = session.type === "wsl"
      ? spawnSync("wsl.exe", ["-d", session.wslDistro, "--", "sh", "-lc", `command -v ${shellQuote(command)}`], { windowsHide: true })
      : spawnSync("where.exe", [command], { windowsHide: true });
    if (session.type !== "ssh" && (result.error || result.status !== 0)) throw new Error(`未找到命令：${command}`);
  }

  function runLocal(session, invocation, handlers) {
    let command = invocation.command;
    let args = invocation.args;
    let cwd = session.cwd;
    let env = process.env;
    if (session.type === "windows") {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$listenerArgs = @((ConvertFrom-Json $env:PANNEL_LISTENER_ARGS))",
        "if ($env:PANNEL_LISTENER_PROMPT_AS_ARG -eq '1') { & $env:PANNEL_LISTENER_COMMAND @listenerArgs $env:PANNEL_LISTENER_PROMPT } else { $env:PANNEL_LISTENER_PROMPT | & $env:PANNEL_LISTENER_COMMAND @listenerArgs }",
        "exit $LASTEXITCODE"
      ].join("; ");
      command = "powershell.exe";
      args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
      env = {
        ...process.env,
        PANNEL_LISTENER_COMMAND: invocation.command,
        PANNEL_LISTENER_ARGS: JSON.stringify(invocation.args),
        PANNEL_LISTENER_PROMPT: invocation.stdin || invocation.promptArgument || "",
        PANNEL_LISTENER_PROMPT_AS_ARG: invocation.promptArgument ? "1" : "0"
      };
    } else if (session.type === "wsl") {
      command = "wsl.exe";
      args = ["-d", session.wslDistro, "--cd", session.cwd, "--", invocation.command, ...invocation.args, ...(invocation.promptArgument ? [invocation.promptArgument] : [])];
      cwd = undefined;
    }
    const child = spawn(command, args, { cwd, windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", data => handlers.onStdout(String(data)));
    child.stderr.on("data", data => handlers.onStderr(String(data)));
    if (invocation.stdin) child.stdin.end(invocation.stdin); else child.stdin.end();
    const promise = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode: Number.isInteger(exitCode) ? exitCode : -1, signal }));
    });
    return {
      promise,
      cancel: () => {
        if (process.platform === "win32" && child.pid) {
          spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        } else child.kill("SIGTERM");
      }
    };
  }

  async function run(session, agent, prompt, handlers = {}) {
    const invocation = buildInvocation(agent.provider, agent.permission, prompt, session);
    assertAvailable(session, agent.provider);
    if (session.type !== "ssh") return runLocal(session, invocation, { onStdout: handlers.onStdout || (() => {}), onStderr: handlers.onStderr || (() => {}) });
    const remoteArgs = [...invocation.args, ...(invocation.promptArgument ? [invocation.promptArgument] : [])];
    const remoteCommand = `cd ${shellQuote(session.cwd)} && ${shellQuote(invocation.command)} ${remoteArgs.map(shellQuote).join(" ")}`;
    return sshSessionRuntime.execStreaming(session.id, remoteCommand, {
      stdin: invocation.stdin,
      onStdout: handlers.onStdout,
      onStderr: handlers.onStderr,
      actionName: `${agent.name} (${randomUUID()})`
    });
  }

  return { run, assertAvailable };
}

module.exports = { COMMANDS, buildInvocation, createListenerAgentCli, shellQuote };
