const fs = require("node:fs");
const { randomUUID } = require("node:crypto");

function normalizeSessionTemplateIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const ids = [];
  for (const item of value) {
    const id = String(item || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function createLaunchTemplateStore({ templatesFile, now = () => Date.now(), createId = () => randomUUID() }) {
  let launchTemplates = [];

  function clone(template) {
    return {
      ...template,
      sessionTemplateIds: [...template.sessionTemplateIds]
    };
  }

  function normalizeStoredTemplate(template) {
    if (!template || typeof template !== "object" || Array.isArray(template)) return undefined;
    const name = String(template.name || "").trim();
    if (!name) return undefined;
    const createdAt = Number.isFinite(template.createdAt) ? template.createdAt : now();
    return {
      id: String(template.id || "").trim() || createId(),
      name,
      sessionTemplateIds: normalizeSessionTemplateIds(template.sessionTemplateIds),
      createdAt,
      updatedAt: Number.isFinite(template.updatedAt) ? template.updatedAt : createdAt
    };
  }

  function save() {
    const payload = {
      schemaVersion: 1,
      launchTemplates
    };
    const tempFile = `${templatesFile}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tempFile, templatesFile);
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(templatesFile, "utf-8"));
      const items = Array.isArray(parsed) ? parsed : parsed?.launchTemplates;
      if (!Array.isArray(items)) {
        launchTemplates = [];
        return getAll();
      }
      const names = new Set();
      launchTemplates = items.reduce((result, item) => {
        const normalized = normalizeStoredTemplate(item);
        const nameKey = normalized?.name.toLocaleLowerCase();
        if (!normalized || names.has(nameKey)) return result;
        names.add(nameKey);
        result.push(normalized);
        return result;
      }, []);
      return getAll();
    } catch (err) {
      if (err.code !== "ENOENT") console.error("Failed to load launch templates:", err);
      launchTemplates = [];
      return [];
    }
  }

  function getAll() {
    return launchTemplates.map(clone);
  }

  function get(id) {
    const template = launchTemplates.find(item => item.id === id);
    return template ? clone(template) : undefined;
  }

  function validateName(name, currentId) {
    const normalized = String(name || "").trim();
    if (!normalized) throw new Error("Launch template name is required.");
    const key = normalized.toLocaleLowerCase();
    if (launchTemplates.some(item => item.id !== currentId && item.name.toLocaleLowerCase() === key)) {
      throw new Error("Launch template name already exists.");
    }
    return normalized;
  }

  function create(input = {}) {
    const timestamp = now();
    const template = {
      id: createId(),
      name: validateName(input.name),
      sessionTemplateIds: normalizeSessionTemplateIds(input.sessionTemplateIds),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    launchTemplates.push(template);
    save();
    return clone(template);
  }

  function update(id, input = {}) {
    const index = launchTemplates.findIndex(item => item.id === id);
    if (index < 0) throw new Error("Launch template not found.");
    const current = launchTemplates[index];
    launchTemplates[index] = {
      ...current,
      name: validateName(input.name, id),
      sessionTemplateIds: normalizeSessionTemplateIds(input.sessionTemplateIds),
      updatedAt: now()
    };
    save();
    return clone(launchTemplates[index]);
  }

  function remove(id) {
    const next = launchTemplates.filter(item => item.id !== id);
    if (next.length === launchTemplates.length) return getAll();
    launchTemplates = next;
    save();
    return getAll();
  }

  function removeSessionTemplate(sessionTemplateId) {
    const id = String(sessionTemplateId || "").trim();
    if (!id) return getAll();
    let changed = false;
    launchTemplates = launchTemplates.map((template) => {
      const sessionTemplateIds = template.sessionTemplateIds.filter(item => item !== id);
      if (sessionTemplateIds.length === template.sessionTemplateIds.length) return template;
      changed = true;
      return { ...template, sessionTemplateIds, updatedAt: now() };
    });
    if (changed) save();
    return getAll();
  }

  return { load, getAll, get, create, update, remove, removeSessionTemplate };
}

module.exports = {
  createLaunchTemplateStore,
  normalizeSessionTemplateIds
};
