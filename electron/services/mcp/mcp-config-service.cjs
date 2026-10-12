const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { applyEdits, modify, parse: parseJsonc, printParseErrorCode } = require("jsonc-parser");
const { parse: parseToml, stringify: stringifyToml } = require("smol-toml");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const PROVIDERS = new Set(["codex", "opencode", "codebuddy"]);
const SCOPES = {
  codex: new Set(["user", "project"]),
  opencode: new Set(["user", "project"]),
  codebuddy: new Set(["user", "project-local", "project"])
};
const SENSITIVE_URL_PATTERN = /[?]|^[a-z][a-z\d+.-]*:\/\/[^/]*@/i;
const SENSITIVE_ARG_PATTERN = /(?:token|password|passwd|secret|api[-_]?key|authorization)/i;

function versionOf(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readConfigFile(filePath, fsApi = fs) {
  let fd;
  try {
    fd = fsApi.openSync(filePath, "r");
    if (fsApi.fstatSync(fd).size > MAX_CONFIG_BYTES) throw new Error("MCP configuration is too large to edit.");
    // Bound reads even if the file grows after fstat; tolerate short reads.
    const storage = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < storage.length) {
      const count = fsApi.readSync(fd, storage, bytesRead, storage.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_CONFIG_BYTES) throw new Error("MCP configuration is too large to edit.");
    const buffer = storage.subarray(0, bytesRead);
    return { buffer, text: buffer.toString("utf-8"), version: versionOf(buffer), exists: true };
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    return { buffer: Buffer.alloc(0), text: "", version: "missing", exists: false };
  } finally {
    if (fd !== undefined) fsApi.closeSync(fd);
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

function resolveProjectDirectory(homeDir, terminalManager, graphicalService, sessionId) {
  const session = terminalManager?.getSession?.(String(sessionId || ""));
  if (!session) throw new Error("Select a running Windows session to manage project MCP configuration.");
  if (session.type !== "windows" && !(session.type === "ssh" && session.agentLocation === "local"))
    throw new Error("Project MCP management currently supports Windows sessions only.");
  const workspaceCwd = session.type === "ssh" && session.agentLocation === "local"
    ? graphicalService?.getWorkspaceCwd?.(session.id) : session.cwd;
  const rawCwd = String(workspaceCwd || "").trim();
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

function openCodeConfigPath(directory, fsApi = fs) {
  const jsonc = path.join(directory, "opencode.jsonc");
  return fsApi.existsSync(jsonc) ? jsonc : path.join(directory, "opencode.json");
}

function resolveTarget({ provider, scope, sessionId }, { homeDir, terminalManager, graphicalService, environmentService, fsApi }) {
  validateProviderScope(provider, scope);
  const projectDirectory = scope === "user" ? undefined : resolveProjectDirectory(homeDir, terminalManager, graphicalService, sessionId);
  const session = sessionId ? terminalManager?.getSession?.(String(sessionId)) : null;
  const sessionCodexHome = provider === "codex" && session?.runtimeMode === "app-server"
    ? environmentService?.resolve?.(session)?.CODEX_HOME : undefined;
  const codexHome = sessionCodexHome || process.env.CODEX_HOME;
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
  if (provider === "opencode") {
    const configBase = process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
    return { provider, scope, projectDirectory,
      filePath: openCodeConfigPath(scope === "user" ? path.join(configBase, "opencode") : projectDirectory, fsApi) };
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

function parseJsonDocument(text, provider = "CodeBuddy") {
  if (!text.trim()) return {};
  const errors = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const first = errors[0];
    throw new Error(`Invalid ${provider} MCP JSON (${printParseErrorCode(first.error)} at offset ${first.offset}).`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${provider} MCP configuration must be a JSON object.`);
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
  const openCode = target.provider === "opencode";
  const rawCommand = openCode ? (Array.isArray(safeConfig.command) ? safeConfig.command.map(String) : []) : [];
  const transport = (openCode ? safeConfig.type === "local" : safeConfig.command)
    ? "stdio"
    : target.provider === "codebuddy" && safeConfig.type === "sse" ? "sse" : "http";
  const rawUrl = typeof safeConfig.url === "string" ? safeConfig.url : "";
  const urlMasked = Boolean(rawUrl && SENSITIVE_URL_PATTERN.test(rawUrl));
  const rawArgs = openCode ? rawCommand.slice(1) : Array.isArray(safeConfig.args) ? safeConfig.args.map(String) : [];
  const argsMasked = rawArgs.some((arg, index) => SENSITIVE_ARG_PATTERN.test(arg) || (index > 0 && SENSITIVE_ARG_PATTERN.test(rawArgs[index - 1])));
  return {
    id: `${target.scope}:${name}`,
    provider: target.provider,
    scope: target.scope,
    name,
    enabled,
    transport,
    command: openCode ? rawCommand[0] || "" : typeof safeConfig.command === "string" ? safeConfig.command : "",
    args: argsMasked ? [] : rawArgs,
    argsMasked,
    cwd: typeof safeConfig.cwd === "string" ? safeConfig.cwd : "",
    url: urlMasked ? "" : rawUrl,
    urlMasked,
    bearerTokenEnvVar: typeof safeConfig.bearer_token_env_var === "string" ? safeConfig.bearer_token_env_var : "",
    env: normalizeEntries(openCode ? safeConfig.environment : safeConfig.env),
    headers: normalizeEntries(safeConfig.http_headers || safeConfig.headers),
    startupTimeoutSec: openCode ? numberOrUndefined(safeConfig.timeout?.startup) === undefined ? undefined : safeConfig.timeout.startup / 1000 : numberOrUndefined(safeConfig.startup_timeout_sec),
    toolTimeoutSec: openCode ? numberOrUndefined(safeConfig.timeout?.execution) === undefined ? undefined : safeConfig.timeout.execution / 1000 : numberOrUndefined(safeConfig.tool_timeout_sec)
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

function openCodeServers(document) {
  const mcp = document.mcp;
  if (mcp !== undefined && (!mcp || typeof mcp !== "object" || Array.isArray(mcp)))
    throw new Error("OpenCode mcp must be a JSON object.");
  const servers = mcp?.servers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers)))
    throw new Error("OpenCode mcp.servers must be a JSON object.");
  return servers || {};
}

function listOpenCode(record, target) {
  return Object.entries(openCodeServers(parseJsonDocument(record.text, "OpenCode")))
    .map(([name, config]) => toSummary(name, config, config?.disabled !== true, target));
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
  const allowedTransports = provider === "codebuddy" ? new Set(["stdio", "http", "sse"]) : new Set(["stdio", "http"]);
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
  if (provider === "opencode") {
    delete next.environment;
    delete next.disabled;
    delete next.timeout;
    if (draft.transport === "stdio") {
      delete next.oauth;
      next.type = "local";
      next.command = [draft.command, ...(draft.argsMasked ? existing.command?.slice(1) || [] : draft.args)];
      if (draft.cwd) next.cwd = draft.cwd;
      if (draft.env.length) next.environment = mergeEntries(existing.environment, draft.env);
    } else {
      next.type = "remote";
      next.url = draft.urlMasked ? existing.url : draft.url;
      if (draft.headers.length) next.headers = mergeEntries(existing.headers, draft.headers);
    }
    next.disabled = !draft.enabled;
    const timeout = { ...(existing.timeout && typeof existing.timeout === "object" ? existing.timeout : {}) };
    if (draft.startupTimeoutSec !== undefined) timeout.startup = Math.round(draft.startupTimeoutSec * 1000);
    else delete timeout.startup;
    if (draft.toolTimeoutSec !== undefined) timeout.execution = Math.round(draft.toolTimeoutSec * 1000);
    else delete timeout.execution;
    if (Object.keys(timeout).length) next.timeout = timeout;
    return next;
  }
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

function scanTomlStringState(line, state) {
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (state) {
      if (state[0] === '"' && char === "\\") { index += 1; continue; }
      if (line.startsWith(state, index)) {
        // Closing multiline delimiters may include one or two literal quotes.
        let end = index + state.length;
        if (state.length === 3) while (line[end] === state[0]) end += 1;
        index = end - 1;
        state = "";
      }
    } else {
      if (char === "#") break;
      if (char === '"' || char === "'") {
        state = line.startsWith(char.repeat(3), index) ? char.repeat(3) : char;
        index += state.length - 1;
      }
    }
  }
  return state;
}

function replaceCodexServer(text, originalName, name, config) {
  const lines = text.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) || [];
  const matches = [];
  const boundaries = new Set();
  let stringState = "";
  for (let index = 0; index < lines.length; index += 1) {
    const header = !stringState && lines[index].match(/^\s*(\[\[?)((?:"(?:\\[^\r\n]|[^"\\\r\n])*"|'[^'\r\n]*'|[^\[\]"'\r\n])+)(\]\]?)\s*(?:#.*)?(?:\r\n|\n|\r|$)$/);
    if (!stringState && /^\s*\[[^\r\n]+]\s*(?:#.*)?(?:\r\n|\n|\r|$)$/.test(lines[index])) boundaries.add(index);
    stringState = scanTomlStringState(lines[index], stringState);
    if (!header || header[1].length !== header[3].length) continue;
    const parts = parseTomlHeaderPath(header[2]);
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
    while (end < lines.length && !boundaries.has(end)) end += 1;
    for (let index = start; index < end; index += 1) remove.add(index);
  }
  let output = lines.filter((_line, index) => !remove.has(index)).join("");
  if (name && config) {
    const block = stringifyToml({ mcp_servers: { [name]: config } }).trim();
    output = `${output.trimEnd()}${output.trim() ? "\n\n" : ""}${block}\n`;
  }
  parseTomlDocument(output);
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

function stringRecord(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`MCP ${label} 必须是对象。`);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`MCP ${label}.${key} 必须是字符串。`);
  }
  return value;
}

function openCodeToolAction(serverName, toolName) {
  return `${serverName}_${toolName}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

function convertCodexToolPermissions(serverName, config) {
  const hasAllowlist = config.enabled_tools !== undefined;
  const hasDefault = config.default_tools_approval_mode !== undefined;
  const hasOverrides = config.tools !== undefined;
  if (!hasAllowlist && !hasDefault && !hasOverrides) return [];

  const approvalEffect = (mode, field) => {
    if (mode === "prompt") return "ask";
    if (mode === "approve") return "allow";
    throw new Error(`无法等价复制 MCP ${field}：${String(mode)}。`);
  };
  if (hasAllowlist && (!Array.isArray(config.enabled_tools)
    || config.enabled_tools.some(name => typeof name !== "string" || !name.trim())))
    throw new Error("MCP enabled_tools 必须是非空工具名组成的数组。");
  if (hasOverrides && (!config.tools || typeof config.tools !== "object" || Array.isArray(config.tools)))
    throw new Error("MCP tools 必须是对象。");

  const defaultEffect = hasDefault ? approvalEffect(config.default_tools_approval_mode, "default_tools_approval_mode") : "allow";
  const overrides = new Map();
  for (const [name, value] of Object.entries(config.tools || {})) {
    if (!name.trim() || !value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => key !== "approval_mode") || value.approval_mode === undefined)
      throw new Error(`无法等价复制 MCP tools.${name}。`);
    const action = openCodeToolAction(serverName, name);
    if (overrides.has(action)) throw new Error(`无法等价复制 MCP tools：工具名规范化后重复 (${name})。`);
    overrides.set(action, approvalEffect(value.approval_mode, `tools.${name}.approval_mode`));
  }

  const serverAction = `${openCodeToolAction(serverName, "")}*`;
  const rule = (action, effect) => ({ action, resource: "*", effect });
  if (!hasAllowlist) return [
    ...(hasDefault ? [rule(serverAction, defaultEffect)] : []),
    ...[...overrides].map(([action, effect]) => rule(action, effect))
  ];

  const names = new Map();
  for (const name of config.enabled_tools) {
    const action = openCodeToolAction(serverName, name);
    if (names.has(action)) throw new Error(`无法等价复制 MCP enabled_tools：工具名规范化后重复 (${name})。`);
    names.set(action, name);
  }
  return [rule(serverAction, "deny"),
    ...[...names].map(([action]) => rule(action, overrides.get(action) || defaultEffect))];
}

function convertServer(sourceProvider, config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("MCP 服务配置格式无效。");
  const openCode = sourceProvider === "opencode";
  const local = openCode ? config.type === "local" : typeof config.command === "string";
  const remote = openCode ? config.type === "remote" : typeof config.url === "string";
  if (local === remote) throw new Error("MCP 服务必须明确使用 stdio 或 HTTP 传输方式。");
  if (openCode && config.disabled !== undefined && typeof config.disabled !== "boolean") throw new Error("OpenCode MCP disabled 必须是布尔值。");
  if (!openCode && config.enabled !== undefined && typeof config.enabled !== "boolean") throw new Error("Codex MCP enabled 必须是布尔值。");
  if (config.cwd !== undefined && typeof config.cwd !== "string") throw new Error("MCP cwd 必须是字符串。");
  const supported = new Set(openCode
    ? ["type", "command", "cwd", "environment", "url", "headers", "disabled", "timeout", "oauth"]
    : ["command", "args", "cwd", "env", "env_vars", "url", "http_headers", "env_http_headers", "bearer_token_env_var", "enabled", "startup_timeout_sec", "tool_timeout_sec", "enabled_tools", "default_tools_approval_mode", "tools"]);
  const unsupported = Object.keys(config).filter(key => !supported.has(key));
  if (local) {
    const allowed = new Set(openCode ? ["type", "command", "cwd", "environment", "disabled", "timeout"]
      : ["command", "args", "cwd", "env", "env_vars", "enabled", "startup_timeout_sec", "tool_timeout_sec", "enabled_tools", "default_tools_approval_mode", "tools"]);
    unsupported.push(...Object.keys(config).filter(key => supported.has(key) && !allowed.has(key)));
  } else {
    const allowed = new Set(openCode ? ["type", "url", "headers", "disabled", "timeout", "oauth"]
      : ["url", "http_headers", "env_http_headers", "bearer_token_env_var", "enabled", "startup_timeout_sec", "tool_timeout_sec", "enabled_tools", "default_tools_approval_mode", "tools"]);
    unsupported.push(...Object.keys(config).filter(key => supported.has(key) && !allowed.has(key)));
  }
  if (openCode && config.oauth !== undefined && (config.oauth !== false || !Object.keys(config.headers || {}).some(key => key.toLowerCase() === "authorization")))
    unsupported.push("oauth");
  if (openCode && config.timeout && Object.keys(config.timeout).some(key => !["startup", "execution"].includes(key))) unsupported.push("timeout.catalog");
  if (unsupported.length) throw new Error(`无法等价复制 MCP 设置：${[...new Set(unsupported)].join(", ")}`);

  const seconds = (value, label) => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`MCP ${label} 必须是正数。`);
    return value;
  };
  const milliseconds = (value, label) => {
    if (value === undefined) return undefined;
    const converted = value * 1000;
    if (!Number.isSafeInteger(converted) || converted <= 0)
      throw new Error(`无法等价复制 MCP ${label}，OpenCode 需要整数毫秒。`);
    return converted;
  };
  if (openCode && config.timeout !== undefined && (!config.timeout || typeof config.timeout !== "object" || Array.isArray(config.timeout)))
    throw new Error("OpenCode MCP timeout 必须是对象。");
  const timeout = openCode ? config.timeout || {} : {};
  const startup = openCode ? seconds(timeout.startup, "startup timeout") : seconds(config.startup_timeout_sec, "startup timeout");
  const execution = openCode ? seconds(timeout.execution, "execution timeout") : seconds(config.tool_timeout_sec, "tool timeout");
  if (openCode && [startup, execution].some(value => value !== undefined && !Number.isInteger(value)))
    throw new Error("OpenCode MCP 超时必须是整数毫秒。");

  if (local) {
    if (openCode) {
      if (!Array.isArray(config.command) || !config.command.length || config.command.some(value => typeof value !== "string"))
        throw new Error("OpenCode 本地 MCP command 必须是非空字符串数组。");
      const environment = stringRecord(config.environment, "environment");
      const env = {};
      const envVars = [];
      for (const [key, value] of Object.entries(environment)) {
        if (typeof value !== "string") throw new Error(`MCP 环境变量 ${key} 必须是字符串。`);
        const match = value.match(/^\{env:([A-Za-z_][A-Za-z\d_]*)\}$/);
        if (match) {
          if (match[1] !== key) throw new Error(`无法等价复制 MCP 环境变量：${key}`);
          envVars.push(key);
        } else if (value.includes("{env:")) throw new Error(`无法等价复制 MCP 环境变量：${key}`);
        else env[key] = value;
      }
      return { command: config.command[0], args: config.command.slice(1), ...(config.cwd ? { cwd: config.cwd } : {}),
        ...(Object.keys(env).length ? { env } : {}), ...(envVars.length ? { env_vars: envVars } : {}),
        enabled: config.disabled !== true,
        ...(startup !== undefined ? { startup_timeout_sec: startup / 1000 } : {}),
        ...(execution !== undefined ? { tool_timeout_sec: execution / 1000 } : {}) };
    }
    if (typeof config.command !== "string" || !config.command.trim() || (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(value => typeof value !== "string"))))
      throw new Error("Codex 本地 MCP 命令或参数格式无效。");
    const environment = { ...stringRecord(config.env, "env") };
    for (const [key, value] of Object.entries(environment)) {
      if (value.includes("{env:")) throw new Error(`无法等价复制 MCP 环境变量：${key}`);
    }
    if (config.env_vars !== undefined && !Array.isArray(config.env_vars)) throw new Error("MCP env_vars 必须是数组。");
    for (const entry of config.env_vars || []) {
      const name = typeof entry === "string" ? entry : entry?.source === "local" ? entry.name : null;
      if (!/^[A-Za-z_][A-Za-z\d_]*$/.test(name || "") || Object.hasOwn(environment, name))
        throw new Error("无法等价复制 MCP env_vars。");
      environment[name] = `{env:${name}}`;
    }
    return { type: "local", command: [config.command, ...(config.args || [])], ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(Object.keys(environment).length ? { environment } : {}), disabled: config.enabled === false,
      ...(startup !== undefined || execution !== undefined ? { timeout: {
        ...(startup !== undefined ? { startup: milliseconds(startup, "startup timeout") } : {}),
        ...(execution !== undefined ? { execution: milliseconds(execution, "execution timeout") } : {}) } } : {}) };
  }

  if (typeof config.url !== "string" || !/^https?:\/\//i.test(config.url) || config.url.includes("{env:"))
    throw new Error("无法等价复制 MCP URL。");
  if (openCode) {
    const headers = {};
    const envHttpHeaders = {};
    let bearerTokenEnvVar;
    for (const [key, value] of Object.entries(stringRecord(config.headers, "headers"))) {
      const bearer = key.toLowerCase() === "authorization" && value.match(/^Bearer \{env:([A-Za-z_][A-Za-z\d_]*)\}$/);
      const variable = value.match(/^\{env:([A-Za-z_][A-Za-z\d_]*)\}$/);
      if (bearer) bearerTokenEnvVar = bearer[1];
      else if (variable) envHttpHeaders[key] = variable[1];
      else if (value.includes("{env:")) throw new Error(`无法等价复制 MCP Header：${key}`);
      else headers[key] = value;
    }
    return { url: config.url, enabled: config.disabled !== true,
      ...(Object.keys(headers).length ? { http_headers: headers } : {}),
      ...(Object.keys(envHttpHeaders).length ? { env_http_headers: envHttpHeaders } : {}),
      ...(bearerTokenEnvVar ? { bearer_token_env_var: bearerTokenEnvVar } : {}),
      ...(startup !== undefined ? { startup_timeout_sec: startup / 1000 } : {}),
      ...(execution !== undefined ? { tool_timeout_sec: execution / 1000 } : {}) };
  }
  const headers = { ...stringRecord(config.http_headers, "http_headers") };
  for (const [key, value] of Object.entries(headers)) {
    if (value.includes("{env:")) throw new Error(`无法等价复制 MCP Header：${key}`);
  }
  for (const [key, variable] of Object.entries(stringRecord(config.env_http_headers, "env_http_headers"))) {
    if (!/^[A-Za-z_][A-Za-z\d_]*$/.test(variable)) throw new Error(`MCP Header ${key} 的环境变量名无效。`);
    if (Object.keys(headers).some(existing => existing.toLowerCase() === key.toLowerCase()))
      throw new Error(`无法等价复制重复 MCP Header：${key}`);
    headers[key] = `{env:${variable}}`;
  }
  if (config.bearer_token_env_var) {
    if (typeof config.bearer_token_env_var !== "string" || !/^[A-Za-z_][A-Za-z\d_]*$/.test(config.bearer_token_env_var))
      throw new Error("MCP bearer_token_env_var 无效。");
    if (Object.keys(headers).some(key => key.toLowerCase() === "authorization"))
      throw new Error("无法等价复制重复 MCP Authorization Header。");
    headers.Authorization = `Bearer {env:${config.bearer_token_env_var}}`;
  }
  return { type: "remote", url: config.url, disabled: config.enabled === false,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(Object.keys(headers).some(key => key.toLowerCase() === "authorization") ? { oauth: false } : {}),
    ...(startup !== undefined || execution !== undefined ? { timeout: {
      ...(startup !== undefined ? { startup: milliseconds(startup, "startup timeout") } : {}),
      ...(execution !== undefined ? { execution: milliseconds(execution, "execution timeout") } : {}) } } : {}) };
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
  const context = { homeDir: path.resolve(homeDir), terminalManager, graphicalService, environmentService, fsApi };

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
    const output = await remoteExec(target, `target=${remotePath(target)}; if [ -f "$target" ]; then printf 'exists:'; base64 < "$target" | tr -d '\\n'; else printf 'missing:'; fi`);
    const exists = output.trim().startsWith("exists:");
    const buffer = exists ? Buffer.from(output.trim().slice("exists:".length), "base64") : Buffer.alloc(0);
    if (buffer.length > MAX_CONFIG_BYTES) throw new Error("MCP 配置文件过大。");
    return { buffer, text: buffer.toString("utf8"), version: exists ? versionOf(buffer) : "missing", exists };
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
    const servers = target.provider === "codex" ? listCodex(record, target)
      : target.provider === "opencode" ? listOpenCode(record, target) : listCodeBuddy(record, target);
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
    } else if (target.provider === "opencode") {
      config = openCodeServers(parseJsonDocument(record.text, "OpenCode"))[name];
    } else {
      const document = parseJsonDocument(record.text);
      config = getAtPath(document, [...codeBuddyPaths(document, target).servers, name]);
    }
    if (!config || typeof config !== "object") throw new Error("MCP server was not found.");
    const field = request.field;
    if (field === "url") return { status: "revealed", value: String(config.url || "") };
    if (field === "args") return { status: "revealed", value: JSON.stringify(target.provider === "opencode"
      ? Array.isArray(config.command) ? config.command.slice(1).map(String) : []
      : Array.isArray(config.args) ? config.args.map(String) : []) };
    if (field === "env") return { status: "revealed", value: String((target.provider === "opencode" ? config.environment : config.env)?.[String(request.key || "")] ?? "") };
    if (field === "headers") {
      return { status: "revealed", value: String((target.provider === "opencode" ? config.headers : config.http_headers || config.headers)?.[String(request.key || "")] ?? "") };
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
    } else if (target.provider === "opencode") {
      const document = parseJsonDocument(record.text, "OpenCode");
      const servers = openCodeServers(document);
      if ((!originalName || originalName !== draft.name) && Object.hasOwn(servers, draft.name))
        throw new Error("An MCP server with this name already exists in the selected scope.");
      const existing = originalName ? servers[originalName] : undefined;
      nextText = record.text;
      if (originalName && originalName !== draft.name) nextText = applyJsonValue(nextText, ["mcp", "servers", originalName], undefined);
      nextText = applyJsonValue(nextText, ["mcp", "servers", draft.name], buildConfig("opencode", draft, existing));
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
    } else if (target.provider === "opencode") {
      const document = parseJsonDocument(record.text, "OpenCode");
      if (!Object.hasOwn(openCodeServers(document), name)) throw new Error("MCP server was not found.");
      nextText = applyJsonValue(record.text, ["mcp", "servers", name], undefined);
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

  function copy(request) {
    const { source, name, expectedSourceVersion, expectedDestinationVersion } = request || {};
    if (!source || !["codex", "opencode"].includes(source.provider) || !["user", "project"].includes(source.scope))
      throw new Error("不支持的 MCP 复制来源。");
    const destinationProvider = source.provider === "codex" ? "opencode" : "codex";
    const sourceTarget = resolveTarget(source, context);
    const destinationRequest = { provider: destinationProvider, scope: source.scope, sessionId: source.sessionId };
    const destinationTarget = resolveTarget(destinationRequest, context);
    const sourceRecord = readConfigFile(sourceTarget.filePath, fsApi);
    const destinationRecord = readConfigFile(destinationTarget.filePath, fsApi);
    if (assertVersion(sourceRecord, expectedSourceVersion) || assertVersion(destinationRecord, expectedDestinationVersion))
      return { status: "conflict" };
    const serverName = validateName(name);
    const sourceServers = source.provider === "codex" ? parseTomlDocument(sourceRecord.text).mcp_servers || {}
      : openCodeServers(parseJsonDocument(sourceRecord.text, "OpenCode"));
    if (!Object.hasOwn(sourceServers, serverName)) throw new Error("MCP server was not found.");
    const destinationServers = destinationProvider === "codex" ? parseTomlDocument(destinationRecord.text).mcp_servers || {}
      : openCodeServers(parseJsonDocument(destinationRecord.text, "OpenCode"));
    if (Object.hasOwn(destinationServers, serverName)) return { status: "exists" };
    const converted = convertServer(source.provider, sourceServers[serverName]);
    const permissionRules = source.provider === "codex"
      ? convertCodexToolPermissions(serverName, sourceServers[serverName]) : [];
    if (permissionRules.length) {
      const sourcePrefix = openCodeToolAction(serverName, "");
      const overlapping = Object.keys(destinationServers).find(name => {
        const prefix = openCodeToolAction(name, "");
        return prefix.startsWith(sourcePrefix) || sourcePrefix.startsWith(prefix);
      });
      if (overlapping) throw new Error(`无法安全复制 MCP 工具权限：服务“${serverName}”与“${overlapping}”的工具名称可能重叠。`);
    }
    let nextText = destinationProvider === "codex"
      ? replaceCodexServer(destinationRecord.text, undefined, serverName, converted)
      : applyJsonValue(destinationRecord.text, ["mcp", "servers", serverName], converted);
    if (permissionRules.length) {
      const destination = parseJsonDocument(destinationRecord.text, "OpenCode");
      if (destination.permissions !== undefined && !Array.isArray(destination.permissions))
        throw new Error("OpenCode permissions 必须是数组，无法复制 MCP 工具权限。");
      if (!destination.permissions) nextText = applyJsonValue(nextText, ["permissions"], permissionRules);
      else for (const [index, rule] of permissionRules.entries()) {
        nextText = applyEdits(nextText, modify(nextText, ["permissions", destination.permissions.length + index], rule,
          { formattingOptions: jsonFormattingOptions(nextText), isArrayInsertion: true }));
      }
    }
    if (readConfigFile(sourceTarget.filePath, fsApi).version !== sourceRecord.version
      || readConfigFile(destinationTarget.filePath, fsApi).version !== destinationRecord.version) return { status: "conflict" };
    atomicWrite(destinationTarget.filePath, nextText, fsApi);
    return { status: "copied", document: list(destinationRequest), serverName, permissionsCopied: permissionRules.length > 0 };
  }

  return { list, reveal, save, remove, copy };
}

module.exports = {
  MAX_CONFIG_BYTES,
  createMcpConfigService,
  normalizeProjectPath,
  parseTomlHeaderPath,
  replaceCodexServer,
  versionOf
};
