const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { parse: parseToml } = require("smol-toml");

const execFileAsync = promisify(execFile);
const quoteBash = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const quotePowerShell = value => `'${String(value).replace(/'/g, "''")}'`;
const isWithin = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

function convertServer(name, value, warnings) {
  if (!value || typeof value !== "object" || value.enabled === false) return null;
  if (value.cwd) throw new Error(`Codex MCP ${name} 设置了 CodeBuddy 不支持的 cwd。`);
  if (value.startup_timeout_sec !== undefined || value.tool_timeout_sec !== undefined) {
    warnings.push(`Codex MCP ${name} 的超时参数无法继承，CodeBuddy 将使用自身默认值。`);
  }
  if (typeof value.command === "string" && value.command) {
    return { type: "stdio", command: value.command, ...(Array.isArray(value.args) ? { args: value.args.map(String) } : {}),
      ...(value.env && typeof value.env === "object" ? { env: Object.fromEntries(Object.entries(value.env).map(([key, val]) => [key, String(val)])) } : {}) };
  }
  if (typeof value.url === "string" && value.url) {
    const headers = Object.fromEntries(Object.entries(value.http_headers || {}).map(([key, val]) => [key, String(val)]));
    for (const [header, envName] of Object.entries(value.env_http_headers || {})) headers[header] = `\${${envName}}`;
    if (value.bearer_token_env_var) headers.Authorization = `Bearer \${${value.bearer_token_env_var}}`;
    return { type: "http", url: value.url, ...(Object.keys(headers).length ? { headers } : {}) };
  }
  throw new Error(`Codex MCP ${name} 缺少 CodeBuddy 可用的 command 或 url。`);
}

function readMcpDocuments(documents, warnings = []) {
  const servers = {};
  for (const [label, content] of documents) {
    if (!content) continue;
    let parsed;
    try { parsed = parseToml(content); }
    catch (error) { throw new Error(`${label} 解析失败：${error.message}`); }
    for (const [name, value] of Object.entries(parsed.mcp_servers || {})) {
      const converted = convertServer(name, value, warnings);
      if (converted) servers[name] = converted;
      else delete servers[name];
    }
  }
  return servers;
}

function copySkillsLocal(sources, pluginRoot) {
  const containsSkill = directory => {
    if (fs.existsSync(path.join(directory, "SKILL.md"))) return true;
    return fs.readdirSync(directory, { withFileTypes: true }).some(entry => entry.isDirectory()
      && containsSkill(path.join(directory, entry.name)));
  };
  const destination = path.join(pluginRoot, "skills");
  for (const source of sources) {
    if (!fs.existsSync(source)) continue;
    const root = fs.realpathSync(source);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name === ".system" || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const directory = fs.realpathSync(path.join(root, entry.name));
      if (!isWithin(root, directory) || !containsSkill(directory)) continue;
      fs.mkdirSync(destination, { recursive: true });
      const target = path.join(destination, entry.name);
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(directory, target, { recursive: true, dereference: false });
    }
  }
  return fs.existsSync(destination);
}

function localAdapter(homeDir = os.homedir()) {
  return {
    separator: path.sep,
    home: homeDir,
    join: path.join,
    async read(file) { try { return await fs.promises.readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return ""; throw error; } },
    async stage(sources) {
      const pluginRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pannel-codex-skills-"));
      try {
        const hasSkills = copySkillsLocal(sources, pluginRoot);
        const skillNames = [];
        const collect = (directory, parts = []) => {
          if (fs.existsSync(path.join(directory, "SKILL.md"))) skillNames.push(parts.join(":"));
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isDirectory()) collect(path.join(directory, entry.name), [...parts, entry.name]);
          }
        };
        if (hasSkills) collect(path.join(pluginRoot, "skills"));
        return { pluginRoot, hasSkills, skillNames };
      } catch (error) { await fs.promises.rm(pluginRoot, { recursive: true, force: true }); throw error; }
    },
    async writeMcp(project, content) {
      const file = path.join(project, `.pannel-handle-codex-${randomUUID()}.json`);
      await fs.promises.writeFile(file, content, { mode: 0o600, flag: "wx" });
      return file;
    },
    async remove(file) { await fs.promises.rm(file, { recursive: true, force: true }); },
    async removeMany(files) { await Promise.all(files.filter(Boolean).map(file => fs.promises.rm(file, { recursive: true, force: true }))); }
  };
}

function createRemoteAdapter(session, { sshAgentTransport, homeDir }) {
  async function run(script) {
    if (session.type === "wsl") {
      const encoded = Buffer.from(script).toString("base64");
      const result = await execFileAsync("wsl.exe", ["-d", session.wslDistro, "--", "bash", "-lc", `printf %s ${encoded} | base64 -d | bash`],
        { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      return result.stdout;
    }
    return sshAgentTransport.exec(session.id, `bash -lc ${quoteBash(script)}`,
      { actionName: "Codex configuration inheritance", timeoutMs: 30000 });
  }
  const join = path.posix.join;
  return {
    separator: "/", join,
    home: homeDir,
    async init() { this.home = (await run("printf '%s' \"$HOME\"")).trim(); },
    async read(file) {
      const output = await run(`if [ -f ${quoteBash(file)} ]; then base64 < ${quoteBash(file)} | tr -d '\\n'; fi`);
      return output ? Buffer.from(output.trim(), "base64").toString("utf8") : "";
    },
    async stage(sources) {
      const script = [
        "set -eu", "root=$(mktemp -d /tmp/pannel-codex-skills-XXXXXX)",
        "mkdir -p \"$root/.codebuddy-plugin\" \"$root/skills\"",
        "printf '%s' '{\"name\":\"codex\",\"version\":\"1.0.0\",\"description\":\"Codex skills inherited by Pannel Handle\"}' > \"$root/.codebuddy-plugin/plugin.json\"",
        ...sources.map(source => `if [ -d ${quoteBash(source)} ]; then for item in ${quoteBash(source)}/*; do [ -L \"$item\" ] && continue; find \"$item\" -name SKILL.md -type f -print -quit | grep -q . || continue; name=$(basename \"$item\"); [ \"$name\" = .system ] && continue; rm -rf -- \"$root/skills/$name\"; cp -a \"$item\" \"$root/skills/$name\"; done; fi`),
        "printf '%s\\n' \"$root\"", "find \"$root/skills\" -name SKILL.md -type f -printf '%h\\n'"
      ].join("\n");
      const lines = (await run(script)).trim().split(/\r?\n/);
      return { pluginRoot: lines[0], hasSkills: lines.length > 1,
        skillNames: lines.slice(1).map(value => value.slice(`${lines[0]}/skills/`.length).replace(/\//g, ":")) };
    },
    async writeMcp(project, content) {
      const file = join(project, `.pannel-handle-codex-${randomUUID()}.json`);
      const encoded = Buffer.from(content).toString("base64");
      await run(`(umask 077; printf '%s' ${quoteBash(encoded)} | base64 -d > ${quoteBash(file)})`);
      return file;
    },
    async remove(file) { await run(`rm -rf -- ${quoteBash(file)}`); },
    async removeMany(files) { if (files.some(Boolean)) await run(`rm -rf -- ${files.filter(Boolean).map(quoteBash).join(" ")}`); }
  };
}

async function prepareCodexInheritance(session, options = {}) {
  const project = options.projectCwd || session.cwd;
  const remote = session.type === "wsl" || (session.type === "ssh" && !options.localBridge);
  const adapter = remote ? createRemoteAdapter(session, options) : localAdapter(options.homeDir);
  if (remote) await adapter.init();
  const join = adapter.join;
  const home = adapter.home;
  const sources = [join(home, ".codex", "skills"), join(project, ".agents", "skills"), join(project, ".codex", "skills")];
  const documents = await Promise.all([
    join(home, ".codex", "config.toml"), join(project, ".codex", "config.toml")
  ].map(async file => [file, await adapter.read(file)]));
  const warnings = [];
  const mcpServers = readMcpDocuments(documents, warnings);
  const stage = await adapter.stage(sources, project);
  if (!remote && stage.hasSkills) {
    const manifestDirectory = path.join(stage.pluginRoot, ".codebuddy-plugin");
    await fs.promises.mkdir(manifestDirectory, { recursive: true });
    await fs.promises.writeFile(path.join(manifestDirectory, "plugin.json"), JSON.stringify({
      name: "codex", version: "1.0.0", description: "Codex skills inherited by Pannel Handle"
    }));
  }
  let mcpFile;
  try {
    if (Object.keys(mcpServers).length) mcpFile = await adapter.writeMcp(project, JSON.stringify({ mcpServers }));
  } catch (error) {
    await adapter.remove(stage.pluginRoot);
    throw error;
  }
  return {
    pluginDir: stage.hasSkills ? stage.pluginRoot : undefined,
    skillNames: stage.skillNames,
    mcpFile, mcpServers,
    warnings,
    async cleanup() {
      await adapter.removeMany([mcpFile, stage.pluginRoot]);
    }
  };
}

function codeBuddyInheritanceArgs(inheritance, shell = "bash") {
  if (!inheritance) return "";
  const quote = shell === "powershell" ? quotePowerShell : shell === "cmd"
    ? value => `"${String(value).replace(/%/g, "%%").replace(/"/g, '""')}"` : quoteBash;
  return [inheritance.pluginDir ? `--plugin-dir ${quote(inheritance.pluginDir)}` : "",
    inheritance.mcpFile ? `--mcp-config ${quote(inheritance.mcpFile)}` : ""].filter(Boolean).join(" ");
}

function createCodexInheritanceManager({ sshAgentTransport, homeDir } = {}) {
  const active = new Map();
  return {
    async prepare(session, options = {}) {
      const inheritance = await prepareCodexInheritance(session, { sshAgentTransport, homeDir, ...options });
      const previous = active.get(session.id);
      active.set(session.id, inheritance);
      if (previous) await previous.cleanup();
      return inheritance;
    },
    async cleanup(id) {
      const inheritance = active.get(id);
      active.delete(id);
      if (inheritance) await inheritance.cleanup();
    }
  };
}

module.exports = { prepareCodexInheritance, codeBuddyInheritanceArgs, readMcpDocuments, createCodexInheritanceManager };
