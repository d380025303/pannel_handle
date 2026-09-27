const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { applyEdits, modify, parse: parseJsonc, printParseErrorCode } = require("jsonc-parser");
const { parse: parseToml, stringify: stringifyToml } = require("smol-toml");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const PROVIDERS = new Set(["codex", "codebuddy"]);
const SCOPES = {
  codex: new Set(["user", "project"]),
  codebuddy: new Set(["user", "project-local", "project"])
};
const SENSITIVE_URL_PATTERN = /[?]|^[a-z][a-z\d+.-]*:\/\/[^/]*@/i;
const SENSITIVE_ARG_PATTERN = /(?:token|password|passwd|secret|api[-_]?key|authorization)/i;

function versionOf(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readConfigFile(filePath, fsApi = fs) {
  try {
    const buffer = fsApi.readFileSync(filePath);
    if (buffer.length > MAX_CONFIG_BYTES) throw new Error("MCP configuration is too large to edit.");
    return { buffer, text: buffer.toString("utf-8"), version: versionOf(buffer), exists: true };
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    return { buffer: Buffer.alloc(0), text: "", version: "missing", exists: false };
  }
}

function atomicWrite(filePath, content, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fsApi.existsSync(filePath)) fsApi.copyFileSync(filePath, `${filePath}.pannel-handle.bak`);
  const tempPath = `${filePath}.pannel-handle.tmp`;
  fsApi.writeFileSync(tempPath, content, "utf-8");
  fsApi.renameSync(tempPath, filePath);
}

function validateProviderScope(provider, scope) {
  if (!PROVIDERS.has(provider)) throw new Error("Unsupported MCP provider.");
  if (!SCOPES[provider].has(scope)) throw new Error("Unsupported MCP configuration scope.");
}

function normalizeProjectPath(value) {
  const resolved = path.resolve(value);
  return resolved.replace(/^([A-Z]):/, (_match, drive) => `${drive.toLowerCase()}:`);
}

function resolveProjectDirectory(homeDir, terminalManager, sessionId) {
  const session = terminalManager?.getSession?.(String(sessionId || ""));
  if (!session) throw new Error("Select a running Windows session to manage project MCP configuration.");
  if (session.type !== "windows" && !(session.type === "ssh" && session.agentLocation === "local"))
    throw new Error("Project MCP management currently supports Windows sessions only.");
  const rawCwd = String(session.cwd || "").trim();
  const cwd = rawCwd === "~" ? homeDir : rawCwd;
  if (!cwd) throw new Error("The active session does not have a working directory.");
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new Error("The active session working directory does not exist.");
  }
  if (!stat.isDirectory()) throw new Error("The active session working directory is not a directory.");
  return path.resolve(cwd);
}

function resolveTarget({ provider, scope, sessionId }, { homeDir, terminalManager, environmentService }) {
  validateProviderScope(provider, scope);
  const projectDirectory = scope === "user" ? undefined : resolveProjectDirectory(homeDir, terminalManager, sessionId);
  const session = sessionId ? terminalManager?.getSession?.(String(sessionId)) : null;
  const codexHome = provider === "codex" && session?.runtimeMode === "app-server"
    ? environmentService?.resolve?.(session)?.CODEX_HOME || process.env.CODEX_HOME : undefined;
  if (provider === "codex") {
    return {
      provider,
      scope,
      projectDirectory,
      filePath: scope === "user"
        ? path.join(codexHome || homeDir, codexHome ? "config.toml" : path.join(".codex", "config.toml"))
        : path.join(projectDirectory, ".codex", "config.toml")
    };
  }
  return {
    provider,
    scope,
    projectDirectory,
    filePath: scope === "project"
      ? path.join(projectDirectory, ".mcp.json")
      : path.join(homeDir, ".codebuddy.json")
  };
}

function parseJsonDocument(text) {
  if (!text.trim()) return {};
  const errors = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const first = errors[0];
    throw new Error(`Invalid CodeBuddy MCP JSON (${printParseErrorCode(first.error)} at offset ${first.offset}).`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CodeBuddy MCP configuration must be a JSON object.");
  return value;
}

function parseTomlDocument(text) {
  if (!text.trim()) return {};
  try {
    return parseToml(text);
  } catch (err) {
    throw new Error(`Invalid Codex MCP TOML: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function findProjectKey(projects, projectDirectory) {
  const expected = normalizeProjectPath(projectDirectory);
  return Object.keys(projects || {}).find((key) => normalizeProjectPath(key).toLowerCase() === expected.toLowerCase()) || expected;
}

function codeBuddyPaths(document, target) {
  if (target.scope === "user") return { servers: ["mcpServers"], disabled: ["disabledMcpServers"] };
  if (target.scope === "project") return { servers: ["mcpServers"], disabled: ["disabledMcpServers"] };
  const projectKey = findProjectKey(document.projects, target.projectDirectory);
  return {
    servers: ["projects", projectKey, "mcpServers"],
    disabled: ["projects", projectKey, "disabledMcpServers"]
  };
}

function getAtPath(value, pathSegments) {
  return pathSegments.reduce((current, key) => current && typeof current === "object" ? current[key] : undefined, value);
}

function normalizeEntries(value, masked = true) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).map(([key, entryValue]) => ({
    key,
    value: masked ? "" : String(entryValue ?? ""),
    masked,
    hasValue: entryValue !== undefined && entryValue !== null && String(entryValue) !== ""
  }));
}

function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toSummary(name, config, enabled, target) {
  const safeConfig = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const transport = safeConfig.command
    ? "stdio"
    : target.provider === "codebuddy" && safeConfig.type === "sse" ? "sse" : "http";
  const rawUrl = typeof safeConfig.url === "string" ? safeConfig.url : "";
  const urlMasked = Boolean(rawUrl && SENSITIVE_URL_PATTERN.test(rawUrl));
  const rawArgs = Array.isArray(safeConfig.args) ? safeConfig.args.map(String) : [];
  const argsMasked = rawArgs.some((arg, index) => SENSITIVE_ARG_PATTERN.test(arg) || (index > 0 && SENSITIVE_ARG_PATTERN.test(rawArgs[index - 1])));
  return {
    id: `${target.scope}:${name}`,
    provider: target.provider,
    scope: target.scope,
    name,
    enabled,
    transport,
    command: typeof safeConfig.command === "string" ? safeConfig.command : "",
    args: argsMasked ? [] : rawArgs,
    argsMasked,
    cwd: typeof safeConfig.cwd === "string" ? safeConfig.cwd : "",
    url: urlMasked ? "" : rawUrl,
    urlMasked,
    bearerTokenEnvVar: typeof safeConfig.bearer_token_env_var === "string" ? safeConfig.bearer_token_env_var : "",
    env: normalizeEntries(safeConfig.env),
    headers: normalizeEntries(safeConfig.http_headers || safeConfig.headers),
    startupTimeoutSec: numberOrUndefined(safeConfig.startup_timeout_sec),
    toolTimeoutSec: numberOrUndefined(safeConfig.tool_timeout_sec)
  };
}

function listCodex(record, target) {
  const document = parseTomlDocument(record.text);
  const servers = document.mcp_servers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    throw new Error("Codex mcp_servers must be a TOML table.");
  }
  return Object.entries(servers || {}).map(([name, config]) => toSummary(name, config, config?.enabled !== false, target));
}

function listCodeBuddy(record, target) {
  const document = parseJsonDocument(record.text);
  const paths = codeBuddyPaths(document, target);
  const servers = getAtPath(document, paths.servers) || {};
  const disabled = new Set((getAtPath(document, paths.disabled) || []).map(String));
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("CodeBuddy mcpServers must be a JSON object.");
  return Object.entries(servers).map(([name, config]) => toSummary(name, config, !disabled.has(name), target));
}

function validateName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 200 || /[\u0000-\u001f]/.test(name)) throw new Error("MCP server name must be 1-200 characters without control characters.");
  if (["__proto__", "prototype", "constructor"].includes(name)) throw new Error("This MCP server name is reserved.");
  return name;
}

function validateEntries(entries, label) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  return entries.map((entry) => {
    const key = String(entry?.key || "").trim();
    if (!key || key.length > 300 || /[\u0000-\u001f]/.test(key)) throw new Error(`${label} names must be non-empty and contain no control characters.`);
    if (seen.has(key)) throw new Error(`${label} names must be unique.`);
    seen.add(key);
    return {
      key,
      value: entry?.masked ? undefined : String(entry?.value ?? ""),
      masked: Boolean(entry?.masked)
    };
  });
}

function validateDraft(provider, draft) {
  const name = validateName(draft?.name);
  const allowedTransports = provider === "codex" ? new Set(["stdio", "http"]) : new Set(["stdio", "http", "sse"]);
  const transport = String(draft?.transport || "");
  if (!allowedTransports.has(transport)) throw new Error("Unsupported MCP transport for this provider.");
  const normalized = {
    name,
    enabled: draft?.enabled !== false,
    transport,
    command: String(draft?.command || "").trim(),
    args: Array.isArray(draft?.args) ? draft.args.map((arg) => String(arg)) : [],
    argsMasked: Boolean(draft?.argsMasked),
    cwd: String(draft?.cwd || "").trim(),
    url: String(draft?.url || "").trim(),
    urlMasked: Boolean(draft?.urlMasked),
    bearerTokenEnvVar: String(draft?.bearerTokenEnvVar || "").trim(),
    env: validateEntries(draft?.env, "Environment variable"),
    headers: validateEntries(draft?.headers, "Header"),
    startupTimeoutSec: draft?.startupTimeoutSec === undefined || draft?.startupTimeoutSec === "" ? undefined : Number(draft.startupTimeoutSec),
    toolTimeoutSec: draft?.toolTimeoutSec === undefined || draft?.toolTimeoutSec === "" ? undefined : Number(draft.toolTimeoutSec)
  };
  if (transport === "stdio" && !normalized.command) throw new Error("A command is required for stdio MCP servers.");
  if (transport !== "stdio") {
    if (!normalized.url && !normalized.urlMasked) throw new Error("A URL is required for remote MCP servers.");
    if (normalized.url) {
      let parsed;
      try { parsed = new URL(normalized.url); } catch { throw new Error("Enter a valid MCP server URL."); }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("MCP server URLs must use HTTP or HTTPS.");
    }
  }
  for (const [label, value] of [["Startup timeout", normalized.startupTimeoutSec], ["Tool timeout", normalized.toolTimeoutSec]]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`${label} must be a positive number.`);
  }
  return normalized;
}

function mergeEntries(existing, entries) {
  const current = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  return Object.fromEntries(entries.map((entry) => [entry.key, entry.masked ? current[entry.key] ?? "" : entry.value]));
}

function buildConfig(provider, draft, existing = {}) {
  const next = { ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}) };
  const known = ["command", "args", "env", "cwd", "url", "headers", "http_headers", "bearer_token_env_var", "startup_timeout_sec", "tool_timeout_sec", "type", "enabled"];
  for (const key of known) delete next[key];
  if (draft.transport === "stdio") {
    next.command = draft.command;
    const args = draft.argsMasked ? existing.args : draft.args;
    if (Array.isArray(args) && args.length) next.args = args;
    if (draft.env.length) next.env = mergeEntries(existing.env, draft.env);
    if (provider === "codex" && draft.cwd) next.cwd = draft.cwd;
    if (provider === "codebuddy") next.type = "stdio";
  } else {
    next.url = draft.urlMasked ? existing.url : draft.url;
    if (draft.headers.length) {
      const headers = mergeEntries(existing.http_headers || existing.headers, draft.headers);
      if (provider === "codex") next.http_headers = headers;
      else next.headers = headers;
    }
    if (provider === "codex" && draft.bearerTokenEnvVar) next.bearer_token_env_var = draft.bearerTokenEnvVar;
    if (provider === "codebuddy") next.type = draft.transport;
  }
  if (provider === "codex") {
    next.enabled = draft.enabled;
    if (draft.startupTimeoutSec !== undefined) next.startup_timeout_sec = draft.startupTimeoutSec;
    if (draft.toolTimeoutSec !== undefined) next.tool_timeout_sec = draft.toolTimeoutSec;
  }
  return next;
}

function parseTomlHeaderPath(header) {
  const result = [];
  let token = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (quote) {
      token += char;
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && char === "\\") escaped = true;
      else if (char === quote && !escaped) quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; token += char; continue; }
    if (char === ".") { result.push(token.trim()); token = ""; continue; }
    token += char;
  }
  result.push(token.trim());
  return result.map((part) => {
    if (part.startsWith('"') && part.endsWith('"')) {
      try { return JSON.parse(part); } catch { return part.slice(1, -1); }
    }
    if (part.startsWith("'") && part.endsWith("'")) return part.slice(1, -1);
    return part;
  });
}

function replaceCodexServer(text, originalName, name, config) {
  const lines = text.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) || [];
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^\s*\[([^\[\]]+)]\s*(?:#.*)?(?:\r\n|\n|\r|$)$/);
    if (!header) continue;
    const parts = parseTomlHeaderPath(header[1]);
    if (parts[0] === "mcp_servers" && parts[1] === originalName) matches.push(index);
  }
  if (!matches.length && originalName) {
    const parsed = parseTomlDocument(text);
    if (parsed.mcp_servers && Object.prototype.hasOwnProperty.call(parsed.mcp_servers, originalName)) {
      throw new Error("Inline Codex mcp_servers entries cannot be edited safely. Convert this server to a TOML table first.");
    }
  }
  const remove = new Set();
  for (const start of matches) {
    let end = start + 1;
    while (end < lines.length && !/^\s*\[[^\r\n]+]\s*(?:#.*)?(?:\r\n|\n|\r|$)$/.test(lines[end])) end += 1;
    for (let index = start; index < end; index += 1) remove.add(index);
  }
  let output = lines.filter((_line, index) => !remove.has(index)).join("").replace(/[\t ]+$/gm, "").replace(/(?:\r?\n){3,}$/g, "\n\n");
  if (name && config) {
    const block = stringifyToml({ mcp_servers: { [name]: config } }).trim();
    output = `${output.trimEnd()}${output.trim() ? "\n\n" : ""}${block}\n`;
  }
  return output;
}

function jsonFormattingOptions(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = text.match(/\n([ \t]+)\S/)?.[1] || "  ";
  return { insertSpaces: !indent.includes("\t"), tabSize: indent.includes("\t") ? 1 : indent.length, eol };
}

function applyJsonValue(text, pathSegments, value) {
  const source = text.trim() ? text : "{}\n";
  return applyEdits(source, modify(source, pathSegments, value, { formattingOptions: jsonFormattingOptions(source) }));
}

function assertVersion(record, expectedVersion) {
  if (!expectedVersion || record.version !== expectedVersion) return { status: "conflict" };
  return null;
}

function bashQuote(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }
function runWsl(distro, script, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn("wsl.exe", ["-d", distro, "--", "bash", "-lic", script],
      { windowsHide: true, stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"] });
    let output = ""; let error = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("MCP 配置操作超时。")); }, 30000);
    child.stdout.on("data", chunk => { output += chunk; if (output.length > MAX_CONFIG_BYTES * 2) child.kill(); });
    child.stderr.on("data", chunk => { error = (error + chunk).slice(-4096); });
    child.on("error", cause => { clearTimeout(timer); reject(cause); });
    child.on("close", code => { clearTimeout(timer); if (code === 0) resolve(output.trim());
      else reject(new Error(error.trim() || `MCP 配置操作失败：${code}`)); });
    if (input !== null) child.stdin.end(input);
  });
}

function createMcpConfigService({ homeDir, terminalManager, graphicalService, sshAgentTransport, sshFileSystem, environmentService, fsApi = fs } = {}) {
  if (!homeDir) throw new Error("A home directory is required.");
  const context = { homeDir: path.resolve(homeDir), terminalManager, environmentService };

  function remoteTarget(request) {
    if (!graphicalService || request?.provider !== "codex" || !request.sessionId) return null;
    const session = terminalManager?.getSession?.(String(request.sessionId));
    if (!session || session.runtimeMode !== "app-server" || (session.agentProvider && session.agentProvider !== "codex"))
      throw new Error("Codex 图形会话不存在。");
    if (session.type !== "wsl" && !(session.type === "ssh" && session.agentLocation !== "local")) return null;
    validateProviderScope(request.provider, request.scope);
    const cwd = graphicalService?.getWorkspaceCwd?.(session.id);
    if (!cwd) throw new Error("Codex 项目目录不可用。");
    return { session, cwd, scope: request.scope,
      path: request.scope === "project" ? `${cwd.replace(/\/$/, "")}/.codex/config.toml` : null };
  }
  async function remoteExec(target, command, input = null) {
    const env = environmentService?.resolve?.(target.session) || {};
    const exports = Object.entries(env).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(key)) throw new Error("环境变量名无效。");
      return `export ${key}=${bashQuote(value)}`;
    });
    const initial = String(target.session.initialCommand || "").trim();
    const script = [...exports, `cd ${bashQuote(target.cwd)}`, ...(initial ? [`{ ${initial}; } 1>&2`] : []), command].join(" && ");
    if (target.session.type === "ssh") return sshAgentTransport.exec(target.session.id,
      `bash -lic ${bashQuote(script)}`, { actionName: "Codex MCP configuration", timeoutMs: 30000 });
    return runWsl(target.session.wslDistro, script, input);
  }
  function remotePath(target) { return target.path ? bashQuote(target.path) : '"${CODEX_HOME:-$HOME/.codex}/config.toml"'; }
  async function remoteRecord(target) {
    const output = await remoteExec(target, `target=${remotePath(target)}; if [ -f "$target" ]; then base64 < "$target" | tr -d '\\n'; fi`);
    const buffer = Buffer.from(output.trim(), "base64");
    if (buffer.length > MAX_CONFIG_BYTES) throw new Error("MCP 配置文件过大。");
    return { buffer, text: buffer.toString("utf8"), version: output.trim() ? versionOf(buffer) : "missing" };
  }
  async function remoteWrite(target, record, text) {
    const current = record.version === "missing" ? "missing" : record.version;
    const prefix = `target=${remotePath(target)}; actual=$(if [ -f "$target" ]; then sha256sum "$target" | cut -d' ' -f1; else printf missing; fi); `
      + `[ "$actual" = ${bashQuote(current)} ] || { echo 'MCP 配置已变化，请刷新后重试。' >&2; exit 3; }; `
      + `mkdir -p "$(dirname "$target")" && if [ -f "$target" ]; then cp -p "$target" "$target.pannel-handle.bak"; fi && `;
    if (target.session.type !== "ssh") {
      await remoteExec(target, `${prefix}tmp="$target.pannel-handle.tmp.$$" && cat > "$tmp" && chmod 600 "$tmp" && mv "$tmp" "$target"`, Buffer.from(text, "utf8"));
      return;
    }
    if (!sshFileSystem) throw new Error("SSH 文件服务不可用。");
    const actualPath = (await remoteExec(target, `target=${remotePath(target)}; printf %s "$target"`)).trim();
    if (!actualPath.startsWith("/")) throw new Error("远程 Codex 配置路径无效。");
    const staging = `${actualPath}.pannel-handle.tmp.${randomUUID()}`;
    try {
      await sshFileSystem.mkdir(target.session.id, path.posix.dirname(actualPath), true);
      await sshFileSystem.put(target.session.id, Buffer.from(text, "utf8"), staging);
      await remoteExec(target, `${prefix}chmod 600 ${bashQuote(staging)} && mv ${bashQuote(staging)} "$target"`);
    } finally { await sshFileSystem.remove(target.session.id, staging).catch(() => {}); }
  }
  function remoteDocument(target, record) {
    const descriptor = { provider: "codex", scope: target.scope };
    return { ...descriptor, path: target.path || "~/.codex/config.toml", projectDirectory: target.scope === "project" ? target.cwd : undefined,
      version: record.version, servers: listCodex(record, descriptor).sort((a, b) => a.name.localeCompare(b.name)) };
  }
  async function remoteList(target) { return remoteDocument(target, await remoteRecord(target)); }
  async function remoteReveal(target, request) {
    const record = await remoteRecord(target);
    if (record.version !== request.expectedVersion) return { status: "conflict" };
    const config = parseTomlDocument(record.text).mcp_servers?.[validateName(request.name)];
    if (!config) throw new Error("MCP server was not found.");
    if (request.field === "url") return { status: "revealed", value: String(config.url || "") };
    if (request.field === "args") return { status: "revealed", value: JSON.stringify(config.args || []) };
    if (request.field === "env" || request.field === "headers") return { status: "revealed", value: String((request.field === "env" ? config.env : config.http_headers || config.headers)?.[String(request.key || "")] ?? "") };
    throw new Error("Unsupported MCP secret field.");
  }
  async function remoteSave(target, request) {
    const record = await remoteRecord(target);
    if (record.version !== request.expectedVersion) return { status: "conflict" };
    const draft = validateDraft("codex", request.draft);
    const originalName = request.originalName ? validateName(request.originalName) : undefined;
    const servers = parseTomlDocument(record.text).mcp_servers || {};
    if ((!originalName || originalName !== draft.name) && Object.prototype.hasOwnProperty.call(servers, draft.name))
      throw new Error("An MCP server with this name already exists in the selected scope.");
    const text = replaceCodexServer(record.text, originalName, draft.name,
      buildConfig("codex", draft, originalName ? servers[originalName] : undefined));
    await remoteWrite(target, record, text);
    return { status: "saved", document: await remoteList(target), serverName: draft.name };
  }
  async function remoteRemove(target, request) {
    const record = await remoteRecord(target);
    if (record.version !== request.expectedVersion) return { status: "conflict" };
    const name = validateName(request.name);
    if (!parseTomlDocument(record.text).mcp_servers?.[name]) throw new Error("MCP server was not found.");
    await remoteWrite(target, record, replaceCodexServer(record.text, name));
    return { status: "removed", document: await remoteList(target) };
  }

  function list(request) {
    const remote = remoteTarget(request);
    if (remote) return remoteList(remote);
    const target = resolveTarget(request || {}, context);
    const record = readConfigFile(target.filePath, fsApi);
    const servers = target.provider === "codex" ? listCodex(record, target) : listCodeBuddy(record, target);
    return {
      provider: target.provider,
      scope: target.scope,
      path: target.filePath,
      projectDirectory: target.projectDirectory,
      version: record.version,
      servers: servers.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
    };
  }

  function reveal(request) {
    const remote = remoteTarget(request);
    if (remote) return remoteReveal(remote, request);
    const target = resolveTarget(request || {}, context);
    const record = readConfigFile(target.filePath, fsApi);
    if (record.version !== request.expectedVersion) return { status: "conflict" };
    const name = validateName(request.name);
    let config;
    if (target.provider === "codex") {
      config = parseTomlDocument(record.text).mcp_servers?.[name];
    } else {
      const document = parseJsonDocument(record.text);
      config = getAtPath(document, [...codeBuddyPaths(document, target).servers, name]);
    }
    if (!config || typeof config !== "object") throw new Error("MCP server was not found.");
    const field = request.field;
    if (field === "url") return { status: "revealed", value: String(config.url || "") };
    if (field === "args") return { status: "revealed", value: JSON.stringify(Array.isArray(config.args) ? config.args.map(String) : []) };
    if (field === "env") return { status: "revealed", value: String(config.env?.[String(request.key || "")] ?? "") };
    if (field === "headers") {
      return { status: "revealed", value: String((config.http_headers || config.headers)?.[String(request.key || "")] ?? "") };
    }
    throw new Error("Unsupported MCP secret field.");
  }

  function save(request) {
    const remote = remoteTarget(request);
    if (remote) return remoteSave(remote, request);
    const target = resolveTarget(request || {}, context);
    const record = readConfigFile(target.filePath, fsApi);
    const conflict = assertVersion(record, request.expectedVersion);
    if (conflict) return conflict;
    const draft = validateDraft(target.provider, request.draft);
    const originalName = request.originalName ? validateName(request.originalName) : undefined;
    let nextText;
    if (target.provider === "codex") {
      const document = parseTomlDocument(record.text);
      const servers = document.mcp_servers || {};
      if ((!originalName || originalName !== draft.name) && Object.prototype.hasOwnProperty.call(servers, draft.name)) {
        throw new Error("An MCP server with this name already exists in the selected scope.");
      }
      const existing = originalName ? servers[originalName] : undefined;
      nextText = replaceCodexServer(record.text, originalName, draft.name, buildConfig("codex", draft, existing));
    } else {
      const document = parseJsonDocument(record.text);
      const paths = codeBuddyPaths(document, target);
      const servers = getAtPath(document, paths.servers) || {};
      if ((!originalName || originalName !== draft.name) && Object.prototype.hasOwnProperty.call(servers, draft.name)) {
        throw new Error("An MCP server with this name already exists in the selected scope.");
      }
      const existing = originalName ? servers[originalName] : undefined;
      nextText = record.text;
      if (originalName && originalName !== draft.name) nextText = applyJsonValue(nextText, [...paths.servers, originalName], undefined);
      nextText = applyJsonValue(nextText, [...paths.servers, draft.name], buildConfig("codebuddy", draft, existing));
      const disabled = new Set((getAtPath(parseJsonDocument(nextText), paths.disabled) || []).map(String));
      disabled.delete(originalName || draft.name);
      if (!draft.enabled) disabled.add(draft.name);
      nextText = applyJsonValue(nextText, paths.disabled, Array.from(disabled));
    }
    atomicWrite(target.filePath, nextText, fsApi);
    return { status: "saved", document: list(request), serverName: draft.name };
  }

  function remove(request) {
    const remote = remoteTarget(request);
    if (remote) return remoteRemove(remote, request);
    const target = resolveTarget(request || {}, context);
    const record = readConfigFile(target.filePath, fsApi);
    const conflict = assertVersion(record, request.expectedVersion);
    if (conflict) return conflict;
    const name = validateName(request.name);
    let nextText;
    if (target.provider === "codex") {
      const document = parseTomlDocument(record.text);
      if (!document.mcp_servers?.[name]) throw new Error("MCP server was not found.");
      nextText = replaceCodexServer(record.text, name);
    } else {
      const document = parseJsonDocument(record.text);
      const paths = codeBuddyPaths(document, target);
      if (!getAtPath(document, [...paths.servers, name])) throw new Error("MCP server was not found.");
      nextText = applyJsonValue(record.text, [...paths.servers, name], undefined);
      const disabled = new Set((getAtPath(parseJsonDocument(nextText), paths.disabled) || []).map(String));
      disabled.delete(name);
      nextText = applyJsonValue(nextText, paths.disabled, Array.from(disabled));
    }
    atomicWrite(target.filePath, nextText, fsApi);
    return { status: "removed", document: list(request) };
  }

  return { list, reveal, save, remove };
}

module.exports = {
  MAX_CONFIG_BYTES,
  createMcpConfigService,
  normalizeProjectPath,
  parseTomlHeaderPath,
  replaceCodexServer,
  versionOf
};
