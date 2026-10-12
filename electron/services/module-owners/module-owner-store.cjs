const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { readJson } = require("../../stores/business-store-io.cjs");
const { z } = require("zod");

const fields = z.object({ name: z.string().trim().min(1).max(200), responsibilities: z.string().trim().min(1).max(20000),
  recentActivity: z.string().trim().max(20000).optional(),
  directories: z.array(z.string().trim().min(1).max(4096)).min(1).max(200) }).strict();
const mutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("add"), ...fields.shape }).strict(),
  z.object({ operation: z.literal("update"), id: z.string().min(1), version: z.number().int().positive(), ...fields.shape }).strict(),
  z.object({ operation: z.literal("delete"), id: z.string().min(1), version: z.number().int().positive() }).strict()
]);
const DEFAULT_PROMPT = "请分析当前项目的目录结构和代码，识别多个有清晰职责边界的项目模块负责人。每个负责人必须包含模块名称、职责、主要负责目录列表（相对项目工作目录）。结合附带的现有负责人信息，自行决定是否新增、修改或删除；保留仍然合理的记录。必须通过 list_module_owners、add_module_owner、update_module_owner、delete_module_owner 工具维护负责人表，不能只在回复中列出建议。修改和删除使用最新记录的 ID 和 version，冲突时重新查询。不修改项目代码。";

function createModuleOwnerStore({ userData, dataStore, broadcast = () => {} }) {
  const file = path.join(userData, "module-owners.json");
  let state = { schemaVersion: 1, templates: {} };
  let loadError;
  try {
    const saved = readJson(dataStore, file);
    if (saved.schemaVersion !== 1 || !saved.templates || typeof saved.templates !== "object" || Array.isArray(saved.templates)) throw new Error("格式无效");
    state = saved;
    const normalize = record => { if (record && record.recentActivity === undefined) record.recentActivity = ""; };
    for (const value of Object.values(state.templates)) {
      for (const task of value.tasks || []) {
        if (Array.isArray(task.tools)) task.tools = task.tools.filter(name => !["search_module_owner_task_runs", "get_module_owner_task_run"].includes(name));
      }
      value.records.forEach(normalize);
      value.history.forEach(entry => {
        normalize(entry.before); normalize(entry.after);
        entry.records?.forEach(normalize);
      });
    }
  } catch (error) { if (error.code !== "ENOENT") loadError = new Error("负责人数据读取失败，请检查负责人存储；为保护已有数据，暂不允许写入。"); }
  const empty = () => ({ revision: 0, records: [], history: [], settings: { mode: "plan", prompt: DEFAULT_PROMPT } });
  function get(templateId) {
    if (loadError) throw loadError;
    return structuredClone(Object.hasOwn(state.templates, templateId) ? state.templates[templateId] : empty());
  }
  function getSchedulerState(templateId) {
    if (loadError) throw loadError;
    const value = Object.hasOwn(state.templates, templateId) ? state.templates[templateId] : empty();
    return { records: value.records.map(record => ({ id: record.id })), tasks: structuredClone(value.tasks || []) };
  }
  function listHistory(templateId, input) {
    const { ownerId } = z.object({ ownerId: z.string().trim().min(1) }).strict().parse(input);
    if (loadError) throw loadError;
    const value = Object.hasOwn(state.templates, templateId) ? state.templates[templateId] : empty();
    return { revision: value.revision, history: structuredClone(value.history.filter(entry => entry.kind === "owner" && entry.ownerId === ownerId)) };
  }
  function commit(next, ids = []) {
    if (loadError) throw loadError;
    if (dataStore) dataStore.write(file, next);
    else {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    }
    state = next;
    for (const templateId of ids) broadcast("module-owners:changed", { templateId });
  }
  function persist(templateId, value) {
    commit({ ...state, templates: { ...state.templates, [templateId]: value } }, [templateId]);
    return get(templateId);
  }
  function directories(values, cwd) {
    const api = /^(?:[A-Za-z]:|\\\\)/.test(cwd || "") ? path.win32 : path.posix;
    return [...new Set(values.map(value => {
      value = value.replace(/\\/g, "/");
      if (api === path.win32 && /^[A-Za-z]:/.test(value) && !api.isAbsolute(value)) throw new Error("负责目录必须位于项目工作目录内。");
      const relative = api.isAbsolute(value) ? api.relative(cwd || ".", value) : api.normalize(value);
      if (api.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${api.sep}`)) throw new Error("负责目录必须位于项目工作目录内。");
      return (relative || ".").replace(/\\/g, "/");
    }))];
  }
  function history(value, operation, source, sessionId, at, ownerId, before, after) {
    value.history.push({ id: randomUUID(), revision: value.revision, operation, source, sessionId, at,
      kind: "owner", ownerId, before: structuredClone(before), after: structuredClone(after) });
  }
  function mutate(templateId, input, { cwd, source = "manual", sessionId } = {}) {
    const parsed = mutationSchema.parse(input);
    const value = get(templateId);
    const at = Date.now();
    const record = value.records.find(item => item.id === parsed.id);
    if (parsed.operation !== "add" && (!record || record.version !== parsed.version)) throw new Error("记录已修改或删除，请重新读取后再操作。");
    if (parsed.operation !== "delete" && value.records.some(item => item.id !== parsed.id && item.name.toLocaleLowerCase() === parsed.name.toLocaleLowerCase())) throw new Error("同一模板中模块名称不能重复。");
    const normalized = parsed.operation === "delete" ? null : { name: parsed.name, responsibilities: parsed.responsibilities, recentActivity: parsed.recentActivity ?? record?.recentActivity ?? "", directories: directories(parsed.directories, cwd) };
    const before = structuredClone(record || null);
    const ownerId = record?.id || randomUUID();
    value.revision += 1;
    if (parsed.operation === "delete") value.records = value.records.filter(item => item.id !== parsed.id);
    else if (record) Object.assign(record, normalized, { version: value.revision, updatedAt: at });
    else value.records.push({ id: ownerId, ...normalized, version: value.revision, createdAt: at, updatedAt: at });
    history(value, parsed.operation, source, sessionId, at, ownerId, before, value.records.find(item => item.id === ownerId) || null);
    return persist(templateId, value);
  }
  function restore(templateId, input) {
    const { historyId, revision } = z.object({ historyId: z.string().min(1), revision: z.number().int().nonnegative() }).strict().parse(input);
    const value = get(templateId);
    if (value.revision !== revision) throw new Error("负责人表已变更，请重新预览后回滚。");
    const target = value.history.find(item => item.id === historyId);
    if (!target) throw new Error("历史记录不存在。");
    if (target.kind !== "owner") throw new Error("旧版整表快照仅供查看，不能恢复。");
    const desired = target.operation === "delete" ? target.before : target.after;
    if (desired && value.records.some(item => item.id !== target.ownerId && item.name.toLocaleLowerCase() === desired.name.toLocaleLowerCase())) throw new Error("同一模板中模块名称不能重复，无法恢复该负责人。");
    const before = structuredClone(value.records.find(item => item.id === target.ownerId) || null);
    const at = Date.now();
    value.revision += 1;
    const after = desired ? { ...structuredClone(desired), version: value.revision, updatedAt: at } : null;
    const position = value.records.findIndex(item => item.id === target.ownerId);
    if (position >= 0) {
      if (after) value.records[position] = after;
      else value.records.splice(position, 1);
    } else if (after) value.records.push(after);
    history(value, "restore", "manual", undefined, at, target.ownerId, before, after);
    return persist(templateId, value);
  }
  function configure(templateId, input) {
    const settings = z.object({ mode: z.enum(["plan", "default"]), prompt: z.string().trim().min(1).max(100000) }).strict().parse(input);
    const value = get(templateId);
    value.settings = settings;
    return persist(templateId, value);
  }
  function tasks(templateId, values) {
    if (loadError) throw loadError;
    const current = Object.hasOwn(state.templates, templateId) ? state.templates[templateId] : empty();
    const value = { ...current, tasks: structuredClone(values) };
    if (!dataStore?.writeModuleOwnerTaskMetadata) return persist(templateId, value);
    const { records, history, ...metadata } = value;
    dataStore.writeModuleOwnerTaskMetadata(templateId, metadata);
    state = { ...state, templates: { ...state.templates, [templateId]: value } };
    broadcast("module-owners:changed", { templateId });
    return get(templateId);
  }
  function promptTemplates() {
    if (loadError) throw loadError;
    return structuredClone(state.promptTemplates || []);
  }
  function replacePromptTemplates(values) {
    commit({ ...state, promptTemplates: structuredClone(values) }, [""]);
    return promptTemplates();
  }
  function publishPrompts(updates) {
    const next = structuredClone(state);
    for (const update of updates) Object.assign(next.templates[update.templateId].tasks.find(value => value.id === update.taskId), update.fields);
    commit(next, [...new Set(updates.map(value => value.templateId))]);
  }
  return { promptTemplates, replacePromptTemplates, publishPrompts, get, getSchedulerState, listHistory, mutate, restore, configure, tasks, templateIds: () => Object.keys(state.templates) };
}
module.exports = { createModuleOwnerStore, DEFAULT_PROMPT };
