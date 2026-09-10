const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function normalizeEntries(entries = [], windows = false) {
  if (!Array.isArray(entries)) throw new Error("环境变量必须是键值列表。");
  const seen = new Set();
  return entries.map((entry) => {
    const name = String(entry?.name || "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`环境变量名称无效：${name}`);
    if (/^PANNEL_HANDLE_/i.test(name) || /^WSLENV$/i.test(name)) throw new Error(`应用保留变量不可配置：${name}`);
    if (typeof entry.value !== "string" || entry.value.includes("\0")) throw new Error(`环境变量值无效：${name}`);
    const key = windows ? name.toUpperCase() : name;
    if (seen.has(key)) throw new Error(`环境变量名称重复：${name}`);
    seen.add(key);
    return { name, value: entry.value };
  });
}

function mergeEnvironment(layers, windows = false) {
  const result = new Map();
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer || {})) {
      if (value !== undefined) result.set(windows ? name.toUpperCase() : name, [name, String(value)]);
    }
  }
  return Object.fromEntries(result.values());
}

function createEnvironmentService({ configFile, getReferences = () => [] }) {
  let profiles = [];
  if (fs.existsSync(configFile)) {
    profiles = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (!Array.isArray(profiles)) throw new Error("环境变量配置文件无效。");
    profiles = profiles.map(p => ({ ...p, entries: normalizeEntries(p.entries) }));
  }
  function commit(next) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(`${configFile}.tmp`, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(`${configFile}.tmp`, configFile);
    profiles = next;
  }
  function list() {
    return profiles.map(p => ({ ...p, entries: p.entries.map(e => ({ ...e })), references: getReferences().filter(s => s.environmentProfileId === p.id).map(s => s.title) }));
  }
  function save(input) {
    const name = String(input?.name || "").trim();
    if (!name) throw new Error("请输入配置组名称。");
    if (input.id && !profiles.some(p => p.id === input.id)) throw new Error("配置组不存在。");
    const profile = { id: input.id || randomUUID(), name, entries: normalizeEntries(input.entries) };
    if (profiles.some(p => p.id !== profile.id && p.name === name)) throw new Error("配置组名称重复。");
    commit([...profiles.filter(p => p.id !== profile.id), profile]);
    return list();
  }
  function remove(id) {
    const refs = getReferences().filter(s => s.environmentProfileId === id);
    if (refs.length) throw new Error(`配置组正在被引用：${refs.map(s => s.title).join("、")}`);
    commit(profiles.filter(p => p.id !== id));
    return list();
  }
  function preview(session = {}) {
    const windows = session.type === "windows" || (session.type === "ssh" && session.agentProvider && session.agentLocation === "local");
    const profile = session.environmentProfileId ? profiles.find(p => p.id === session.environmentProfileId) : undefined;
    if (session.environmentProfileId && !profile) throw new Error("环境变量配置组不存在，请重新选择。");
    const result = new Map();
    for (const [entries, source] of [[profile?.entries || [], profile?.name || ""], [session.environmentOverrides || [], "会话覆盖"]]) {
      for (const e of normalizeEntries(entries, windows)) result.set(windows ? e.name.toUpperCase() : e.name, { ...e, source });
    }
    return [...result.values()];
  }
  function resolve(session) { return Object.fromEntries(preview(session).map(e => [e.name, e.value])); }
  function snapshot(session) {
    const { environmentProfileId, ...rest } = session;
    return { ...rest, ...(environmentProfileId || session.environmentOverrides ? { environmentOverrides: preview(session).map(({ name, value }) => ({ name, value })) } : {}) };
  }
  return { list, save, remove, preview, resolve, snapshot };
}

module.exports = { createEnvironmentService, normalizeEntries, mergeEnvironment };
