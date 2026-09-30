const fs = require("node:fs");
const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");
const { sanitizeDiagnostic } = require("../codebuddy-acp/http-transport.cjs");

const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const sessionId = value => typeof value === "string" && /^ses_[A-Za-z0-9]+$/.test(value);
const messageId = value => typeof value === "string" && /^msg_[A-Za-z0-9]+$/.test(value);
const OPERATIONS = new Set(["version", "session.get", "session.message.list", "session.update", "session.revert.stage", "session.revert.clear", "session.revert.commit"]);

function windowsExecutable(environment) {
  for (const directory of String(environment.PATH || environment.Path || process.env.PATH || "").split(path.delimiter)) {
    for (const relative of ["opencode.exe", "node_modules/@opencode/cli/bin/opencode.exe"] ) {
      const candidate = path.join(directory, relative);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error("找不到 OpenCode V2 独立程序，请检查安装与 PATH。");
}

async function runOpenCodeHistoryControl({ session, cwd, environment = {}, sshAgentTransport, operation, threadId, body, spawn = defaultSpawn }) {
  if (!OPERATIONS.has(operation) || !sessionId(threadId)) throw new Error("无效的 OpenCode 会话操作。");
  if (operation === "session.revert.stage" && (!messageId(body?.messageID) || body.files !== true))
    throw new Error("无效的 OpenCode 回退消息。");
  const args = operation === "version" ? ["--version"] : ["api", operation, "--standalone", "--param", `sessionID=${threadId}`];
  if (operation === "session.message.list") args.push("--param", "order=desc", "--param", "limit=100");
  if (body !== undefined) args.push("--data", JSON.stringify(body));
  const env = { ...process.env, ...environment };
  // A control process must not impersonate the managed graphical process or load its bridges.
  for (const name of Object.keys(env)) if (name.startsWith("PANNEL_HANDLE_")) delete env[name];
  const secrets = Object.entries(environment).filter(([name]) => /TOKEN|KEY|SECRET|PASSWORD/i.test(name)).map(([, value]) => value);
  const clean = value => sanitizeDiagnostic(String(value), secrets);
  const directory = cwd || session.cwd;
  let output;
  if (session.type === "ssh" && session.agentLocation !== "local") {
    const exports = Object.entries(environment).filter(([name]) => !name.startsWith("PANNEL_HANDLE_")).map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new Error("无效的环境变量。");
      return `export ${name}=${quote(value)}`;
    });
    const command = [...exports, `cd ${quote(directory)}`, `opencode ${args.map(quote).join(" ")}`].join(" && ");
    try { output = await sshAgentTransport.exec(session.id, `bash -lic ${quote(command)}`, { actionName: "OpenCode history control", timeoutMs: 60000 }); }
    catch (error) { throw new Error(clean(error.message)); }
  } else {
    let command, commandArgs, options;
    if (session.type === "wsl") {
      const names = Object.keys(environment).filter(name => !name.startsWith("PANNEL_HANDLE_"));
      env.WSLENV = [...String(env.WSLENV || "").split(":").filter(Boolean), ...names.map(name => `${name}/u`)].join(":");
      command = "wsl.exe";
      commandArgs = ["-d", session.wslDistro, "--", "bash", "-lic", `cd ${quote(directory)} && opencode ${args.map(quote).join(" ")}`];
      options = { env };
    } else { command = windowsExecutable(env); commandArgs = args; options = { env, cwd: directory }; }
    output = await new Promise((resolve, reject) => {
      const child = spawn(command, commandArgs, { ...options, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { child.kill(); finish(new Error("OpenCode 会话操作超时，请刷新状态后重试。")); }, 60000);
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) { child.kill(); finish(new Error("OpenCode 会话操作响应过大。")); } });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.once("error", error => finish(new Error(clean(error.message))));
      child.once("close", code => finish(code === 0 ? null : new Error(clean(stderr || stdout || `OpenCode 操作失败（${code}）。`)), stdout));
    });
  }
  if (operation === "version") return String(output).trim().replace(/^opencode\s+v?/, "");
  if (!String(output).trim()) return null;
  const result = JSON.parse(output);
  if (typeof result?._tag === "string" && /Error$/.test(result._tag)) throw new Error(clean(result.message || result._tag));
  return result.data ?? result;
}

module.exports = { runOpenCodeHistoryControl, isOpenCodeMessageId: messageId };
