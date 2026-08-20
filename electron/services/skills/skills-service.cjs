const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROVIDERS = new Set(["codex", "codebuddy"]);

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
    return { name: directoryName, description: "" };
  }
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (field) fields[field[1]] = unquote(field[2]);
  }
  const name = fields.name || directoryName;
  const description = fields.description || "";
  return { name, description };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function createAdapters(homeDir) {
  const codexRoot = path.join(homeDir, ".codex", "skills");
  return [
    { provider: "codex", source: "user", root: codexRoot, exclude: new Set([".system"]) },
    { provider: "codex", source: "system", root: path.join(codexRoot, ".system"), exclude: new Set() },
    { provider: "codebuddy", source: "user", root: path.join(homeDir, ".codebuddy", "skills"), exclude: new Set() }
  ];
}

function createSkillsService({ homeDir, fsApi = fs } = {}) {
  if (!homeDir) throw new Error("A home directory is required.");
  const adapters = createAdapters(path.resolve(homeDir));

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
      const hasBom = previewBuffer.length >= 3 && previewBuffer[0] === 0xef && previewBuffer[1] === 0xbb && previewBuffer[2] === 0xbf;
      const metadata = parseFrontmatter(previewBuffer.subarray(hasBom ? 3 : 0).toString("utf-8"), entry.name);
      const id = crypto.createHash("sha256")
        .update(`${adapter.provider}\0${adapter.source}\0${realDirectory}`)
        .digest("hex");
      skills.push({
        id,
        name: metadata.name,
        description: metadata.description
      });
    }
    return skills;
  }

  async function list(provider) {
    if (!PROVIDERS.has(provider)) throw new Error("Unsupported Skills provider.");
    const groups = await Promise.all(adapters.filter((adapter) => adapter.provider === provider).map(discoverAdapter));
    return groups.flat()
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  }

  return { list };
}

module.exports = { createSkillsService };
