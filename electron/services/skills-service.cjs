const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const PROVIDERS = new Set(["codex", "codebuddy"]);

function versionOf(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function detectFormat(buffer) {
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const content = buffer.subarray(bom ? 3 : 0).toString("utf-8");
  const firstNewline = content.match(/\r\n|\r|\n/);
  return {
    bom,
    content,
    eol: firstNewline?.[0] === "\r\n" ? "crlf" : firstNewline?.[0] === "\r" ? "cr" : "lf"
  };
}

function normalizeForWrite(content, format) {
  const eol = format.eol === "crlf" ? "\r\n" : format.eol === "cr" ? "\r" : "\n";
  const body = String(content).replace(/\r\n|\r|\n/g, eol);
  const encoded = Buffer.from(body, "utf-8");
  return format.bom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded])
    : encoded;
}

function unquote(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(content, directoryName) {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { name: directoryName, description: "", warning: "SKILL.md is missing valid front matter." };
  }
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (field) fields[field[1]] = unquote(field[2]);
  }
  const name = fields.name || directoryName;
  const description = fields.description || "";
  return {
    name,
    description,
    warning: fields.name && fields.description ? undefined : "SKILL.md front matter is missing name or description."
  };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function createAdapters(homeDir) {
  const codexRoot = path.join(homeDir, ".codex", "skills");
  return [
    { provider: "codex", source: "user", root: codexRoot, editable: true, exclude: new Set([".system"]) },
    { provider: "codex", source: "system", root: path.join(codexRoot, ".system"), editable: false, exclude: new Set() },
    { provider: "codebuddy", source: "user", root: path.join(homeDir, ".codebuddy", "skills"), editable: true, exclude: new Set() }
  ];
}

function createSkillsService({ homeDir, statsStore, translationService, fsApi = fs } = {}) {
  if (!homeDir) throw new Error("A home directory is required.");
  const adapters = createAdapters(path.resolve(homeDir));
  const registry = new Map();

  async function discoverAdapter(adapter) {
    let root;
    try {
      root = await fsApi.promises.realpath(adapter.root);
    } catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
    const entries = await fsApi.promises.readdir(root, { withFileTypes: true });
    const skills = [];
    for (const entry of entries) {
      if (adapter.exclude.has(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const directoryPath = path.join(root, entry.name);
      let realDirectory;
      try {
        realDirectory = await fsApi.promises.realpath(directoryPath);
      } catch {
        continue;
      }
      if (!isWithin(root, realDirectory)) continue;
      const filePath = path.join(realDirectory, "SKILL.md");
      let stat;
      try {
        stat = await fsApi.promises.stat(filePath);
      } catch (err) {
        if (err?.code === "ENOENT") continue;
        throw err;
      }
      if (!stat.isFile()) continue;
      const previewBuffer = await fsApi.promises.readFile(filePath);
      const metadata = parseFrontmatter(detectFormat(previewBuffer).content, entry.name);
      const id = crypto.createHash("sha256")
        .update(`${adapter.provider}\0${adapter.source}\0${realDirectory}`)
        .digest("hex");
      const record = {
        id,
        provider: adapter.provider,
        source: adapter.source,
        directoryName: entry.name,
        path: realDirectory,
        filePath,
        editable: adapter.editable,
        root,
        ...metadata
      };
      registry.set(id, record);
      skills.push(record);
    }
    return skills;
  }

  async function list(provider) {
    if (!PROVIDERS.has(provider)) throw new Error("Unsupported Skills provider.");
    for (const [id, record] of registry) {
      if (record.provider === provider) registry.delete(id);
    }
    const groups = await Promise.all(adapters.filter((adapter) => adapter.provider === provider).map(discoverAdapter));
    let usageRows = [];
    try {
      usageRows = statsStore?.getSkillUsage(provider) || [];
    } catch (error) {
      console.warn("Unable to read Skill usage statistics:", error);
    }
    const usageByName = new Map(usageRows.map(item => [String(item.name || "").trim().toLocaleLowerCase(), Number(item.count) || 0]));
    return groups.flat()
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
      .map(({ filePath: _filePath, root: _root, ...summary }) => {
        const aliases = new Set([summary.name, summary.directoryName].map(value => String(value || "").trim().toLocaleLowerCase()).filter(Boolean));
        const usageCount = [...aliases].reduce((total, alias) => total + (usageByName.get(alias) || 0), 0);
        const registryRecord = registry.get(summary.id);
        if (registryRecord) registryRecord.usageCount = usageCount;
        return { ...summary, usageCount };
      });
  }

  async function resolveRecord(id) {
    let record = registry.get(String(id || ""));
    if (record) return record;
    await Promise.all(Array.from(PROVIDERS, (provider) => list(provider)));
    record = registry.get(String(id || ""));
    if (!record) throw new Error("Skill was not found.");
    return record;
  }

  async function read(id) {
    const record = await resolveRecord(id);
    const realFile = await fsApi.promises.realpath(record.filePath);
    if (!isWithin(record.root, realFile) || path.basename(realFile).toLowerCase() !== "skill.md") {
      throw new Error("Skill path is outside its configured directory.");
    }
    const buffer = await fsApi.promises.readFile(realFile);
    if (buffer.length > MAX_SKILL_BYTES) throw new Error("SKILL.md is too large to edit.");
    const format = detectFormat(buffer);
    return {
      id: record.id,
      provider: record.provider,
      source: record.source,
      name: record.name,
      description: record.description,
      directoryName: record.directoryName,
      path: record.path,
      editable: record.editable,
      usageCount: Number(record.usageCount) || 0,
      warning: record.warning,
      content: format.content,
      version: versionOf(buffer),
      bom: format.bom,
      eol: format.eol
    };
  }

  async function save(id, content, expectedVersion) {
    if (typeof content !== "string") throw new Error("Skill content must be text.");
    if (Buffer.byteLength(content, "utf-8") > MAX_SKILL_BYTES) throw new Error("SKILL.md is too large to save.");
    const record = await resolveRecord(id);
    if (!record.editable) throw new Error("System Skills are read-only.");
    const realFile = await fsApi.promises.realpath(record.filePath);
    if (!isWithin(record.root, realFile) || path.basename(realFile).toLowerCase() !== "skill.md") {
      throw new Error("Skill path is outside its configured directory.");
    }
    const current = await fsApi.promises.readFile(realFile);
    if (!expectedVersion || versionOf(current) !== expectedVersion) return { status: "conflict" };
    const next = normalizeForWrite(content, detectFormat(current));
    await fsApi.promises.writeFile(realFile, next);
    return { status: "saved", version: versionOf(next), size: next.length };
  }

  async function translate(requestId, id, content) {
    if (!translationService) return { status: "error", reason: "unavailable" };
    const record = await resolveRecord(id);
    return translationService.translate({ requestId, provider: record.provider, skillId: record.id, content });
  }

  function cancelTranslation(requestId) {
    return translationService?.cancel(requestId) || false;
  }

  return { list, read, save, translate, cancelTranslation };
}

module.exports = { MAX_SKILL_BYTES, createSkillsService };
