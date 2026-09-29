const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROVIDERS = new Set(["codex", "codebuddy"]);

function unquote(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function parseFrontmatter(content, directoryName) {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { name: directoryName, description: "" };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (field) fields[field[1]] = unquote(field[2]);
  }
  return { name: fields.name || directoryName, description: fields.description || "" };
}

function skillId(provider, filePath) {
  return crypto.createHash("sha256").update(`${provider}\0${filePath}`).digest("hex");
}

function sortSkills(skills) {
  return skills.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    || left.path.localeCompare(right.path));
}

function sourceOfRuntimeSkill(skill, projectPath) {
  const normalized = String(skill.path || "").replace(/\\/g, "/").toLowerCase();
  const scope = typeof skill.scope === "string" ? skill.scope.toLowerCase() : "";
  if (scope.includes("plugin") || normalized.includes("/plugins/cache/")) return "plugin";
  if (scope === "repo" || scope === "project" || scope === "workspace") return "project";
  if (scope === "system" || scope === "admin" || normalized.includes("/skills/.system/")) return "system";
  if (scope === "user" || scope === "personal") return "personal";
  const project = String(projectPath || "").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  return project && normalized.startsWith(`${project}/`) ? "project" : "personal";
}

function createSkillsService({ homeDir, terminalManager, codexAppServerSessionService, environmentService, fsApi = fs } = {}) {
  if (!homeDir) throw new Error("A home directory is required.");
  const home = path.resolve(homeDir);

  async function discover(root, provider, source, excluded = new Set()) {
    let entries;
    try { entries = await fsApi.promises.readdir(root, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return []; throw error; }
    const skills = [];
    for (const entry of entries) {
      if (excluded.has(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const directory = path.join(root, entry.name);
      let realDirectory;
      try { realDirectory = await fsApi.promises.realpath(directory); }
      catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      const filePath = path.join(realDirectory, "SKILL.md");
      let stat;
      try { stat = await fsApi.promises.stat(filePath); }
      catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      if (!stat.isFile()) continue;
      const buffer = await fsApi.promises.readFile(filePath);
      const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
      const metadata = parseFrontmatter(buffer.subarray(hasBom ? 3 : 0).toString("utf-8"), entry.name);
      skills.push({ id: skillId(provider, filePath), name: metadata.name,
        description: metadata.description, path: filePath, source, enabled: true });
    }
    return skills;
  }

  async function projectSkillRoots(cwd) {
    let current;
    try { current = await fsApi.promises.realpath(cwd); }
    catch (error) { if (error?.code === "ENOENT") return []; throw error; }
    const roots = [];
    let repositoryFound = false;
    while (true) {
      roots.push(path.join(current, ".agents", "skills"));
      try { await fsApi.promises.stat(path.join(current, ".git")); repositoryFound = true; break; }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return repositoryFound ? roots : roots.slice(0, 1);
  }

  async function list(provider, sessionId) {
    if (!PROVIDERS.has(provider)) throw new Error("Unsupported Skills provider.");
    const session = sessionId ? terminalManager?.getSession?.(String(sessionId)) : null;
    if (sessionId && !session) throw new Error("Skills session does not exist.");
    if (provider === "codebuddy") {
      const skills = await discover(path.join(home, ".codebuddy", "skills"), provider, "personal");
      return { skills: sortSkills(skills), pluginStatus: "not-applicable", projectStatus: "not-applicable" };
    }

    if (session?.runtimeMode === "app-server" && session.agentProvider === "codex") {
      const projectPath = codexAppServerSessionService?.getWorkspaceCwd?.(session.id) || session.cwd;
      const runtimeSkills = await codexAppServerSessionService.listSkills(session.id, true);
      const skills = runtimeSkills.map(skill => ({
        id: skillId(provider, skill.path), name: skill.name, description: skill.description,
        path: skill.path, source: sourceOfRuntimeSkill(skill, projectPath), enabled: skill.enabled !== false
      }));
      return { skills: sortSkills(skills), pluginStatus: "available", projectStatus: "available", projectPath };
    }

    if (session && session.type !== "windows"
      && !(session.type === "ssh" && session.agentLocation === "local" && session.localAgentCwd)) {
      return { skills: [], pluginStatus: "requires-session", projectStatus: "remote-unavailable",
        projectPath: session.cwd };
    }

    const codexHome = session ? environmentService?.resolve?.(session)?.CODEX_HOME : null;
    const codexRoot = path.resolve(codexHome || process.env.CODEX_HOME || path.join(home, ".codex"));
    const userRoots = [path.join(home, ".agents", "skills"), path.join(codexRoot, "skills")];
    const localCwd = session?.localAgentCwd || (session?.cwd === "~" ? home : session?.cwd);
    const projectRoots = localCwd ? await projectSkillRoots(localCwd) : [];
    const adapters = [
      ...projectRoots.map(root => ({ root, source: "project", excluded: new Set() })),
      ...userRoots.map(root => ({ root, source: "personal", excluded: new Set([".system"]) })),
      { root: path.join(codexRoot, "skills", ".system"), source: "system", excluded: new Set() }
    ];
    const groups = await Promise.all(adapters.map(adapter => discover(adapter.root, provider, adapter.source, adapter.excluded)));
    const seen = new Set();
    const skills = sortSkills(groups.flat().filter(skill => {
      if (seen.has(skill.id)) return false;
      seen.add(skill.id);
      return true;
    }));
    return { skills, pluginStatus: "requires-session", projectStatus: session ? "available" : "no-session",
      ...(session ? { projectPath: localCwd } : {}) };
  }

  return { list };
}

module.exports = { createSkillsService };
