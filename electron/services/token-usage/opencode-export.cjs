const { spawn: defaultSpawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { normalizeOpenCodeMessage } = require("./live/opencode-tracker.cjs");
const { emptyTokens } = require("./agent-token-transcript.cjs");

const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,299}$/;

function bashQuote(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }
function powershellQuote(value) { return `'${String(value).replace(/'/g, "''")}'`; }

function run(command, args, options, spawn = defaultSpawn) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => { child.kill(); fail(new Error("OpenCode session export timed out.")); }, 30000);
    timer.unref?.();
    const fail = error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
    child.stdout.on("data", chunk => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_EXPORT_BYTES) {
        child.kill();
        fail(new Error("OpenCode session export exceeded the size limit."));
        return;
      }
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on("data", chunk => { stderr = (stderr + stderrDecoder.write(chunk)).slice(-2000); });
    child.once("error", fail);
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout += stdoutDecoder.end();
      stderr = (stderr + stderrDecoder.end()).slice(-2000);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `OpenCode session export exited with code ${code}.`));
    });
  });
}

function parseOpenCodeExport(output, threadId) {
  const exported = JSON.parse(output);
  if (exported?.info?.id !== threadId || !Array.isArray(exported.messages))
    throw new Error("OpenCode session export did not match the requested session.");
  const messages = new Map();
  for (const item of exported.messages) {
    const message = normalizeOpenCodeMessage(item?.type === "assistant" ? { info: {
      id: item.id, role: "assistant", tokens: item.tokens,
      modelID: item.model?.providerID && item.model?.id
        ? `${item.model.providerID}/${item.model.id}` : item.model?.id
    } } : item);
    if (message) messages.set(message.id, message);
  }
  const models = new Set([...messages.values()].map(message => message.model).filter(Boolean));
  const sessionUsage = exported.info?.tokens && typeof exported.info.tokens === "object"
    ? normalizeOpenCodeMessage({ info: { id: threadId, role: "assistant", tokens: exported.info.tokens } })
    : null;
  if (exported.info?.model?.providerID && exported.info.model?.id)
    models.add(`${exported.info.model.providerID}/${exported.info.model.id}`);
  const tokens = emptyTokens();
  if (sessionUsage) {
    Object.assign(tokens, sessionUsage.tokens);
  } else {
    for (const message of messages.values())
      for (const field of Object.keys(tokens)) tokens[field] += message.tokens[field] || 0;
  }
  return { tokens, models: [...models] };
}

async function readOpenCodeExport({ threadId, session, cwd, environment = {}, sshAgentTransport, spawn = defaultSpawn }) {
  if (!SESSION_ID.test(String(threadId || ""))) throw new Error("Invalid OpenCode session ID.");
  const directory = cwd || session.cwd;
  const args = `session export --sanitize --standalone ${bashQuote(threadId)}`;
  const exportEnvironment = Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith("PANNEL_HANDLE_")));
  const env = { ...process.env, ...exportEnvironment };
  // Export processes must not load the managed session's hooks or replace its capability endpoint.
  for (const name of Object.keys(env)) if (name.startsWith("PANNEL_HANDLE_")) delete env[name];
  let output;
  if (session.type === "ssh" && session.agentLocation !== "local") {
    const exports = Object.entries(exportEnvironment).map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new Error("Invalid OpenCode environment variable.");
      return `export ${name}=${bashQuote(value)}`;
    });
    const command = `bash -lic ${bashQuote([...exports, `cd ${bashQuote(directory)}`, `opencode ${args}`].join(" && "))}`;
    output = await sshAgentTransport.exec(session.id, command, { actionName: "OpenCode token statistics", timeoutMs: 30000 });
  } else if (session.type === "wsl") {
    const script = `cd ${bashQuote(directory)} && opencode ${args}`;
    const inherited = String(process.env.WSLENV || "").split(":").filter(Boolean);
    const names = new Set(inherited.map(value => value.split("/")[0]));
    for (const name of Object.keys(exportEnvironment)) if (!names.has(name)) inherited.push(`${name}/u`);
    output = await run("wsl.exe", ["-d", session.wslDistro, "--", "bash", "-lic", script],
      { env: { ...env, WSLENV: inherited.filter(value => !value.startsWith("PANNEL_HANDLE_")).join(":") } }, spawn);
  } else {
    const command = `& opencode session export --sanitize --standalone ${powershellQuote(threadId)}`;
    output = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { cwd: directory, env }, spawn);
  }
  if (Buffer.byteLength(output, "utf-8") > MAX_EXPORT_BYTES) throw new Error("OpenCode session export exceeded the size limit.");
  return parseOpenCodeExport(output, threadId);
}

module.exports = { parseOpenCodeExport, readOpenCodeExport };
