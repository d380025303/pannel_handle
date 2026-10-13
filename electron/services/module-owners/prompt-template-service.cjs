const { randomUUID, createHash } = require("node:crypto");
const { z } = require("zod");
const identity = z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict();
const fingerprint = task => createHash("sha256").update(JSON.stringify([task.prompt, task.promptTemplateId, task.promptTemplateVersion, task.promptTemplateSnapshot])).digest("hex");
function createPromptTemplateService({ store, listTemplates }) {
  function references(id) {
    const names = new Map(listTemplates().map(value => [value.templateId, value.title]));
    return store.templateIds().flatMap(templateId => {
      const state = store.get(templateId);
      return (state.tasks || []).filter(task => task.promptTemplateId === id).map(task => ({
        templateId, templateTitle: names.get(templateId) || templateId, ownerName: state.records.find(value => value.id === task.ownerId)?.name || task.ownerId,
        taskId: task.id, taskName: task.name, prompt: task.prompt, fingerprint: fingerprint(task),
        modified: task.prompt !== task.promptTemplateSnapshot, appliedVersion: task.promptTemplateVersion
      }));
    });
  }
  function current(input) {
    const parsed = identity.parse(input);
    const source = store.promptTemplates().find(value => value.id === parsed.id);
    if (!source || source.version !== parsed.version) throw new Error("提示词模板已变更，请刷新后重试。");
    return source;
  }
  function list() {
    const values = store.promptTemplates();
    const counts = new Map();
    if (values.length) {
      for (const templateId of store.templateIds()) {
        for (const task of store.getSchedulerState(templateId).tasks) {
          if (task.promptTemplateId) counts.set(task.promptTemplateId, (counts.get(task.promptTemplateId) || 0) + 1);
        }
      }
    }
    return values.map(value => ({ ...value, referenceCount: counts.get(value.id) || 0 }));
  }
  function save(input) {
    const parsed = z.object({ id: z.string().min(1).optional(), version: z.number().int().positive().optional(), name: z.string().trim().min(1).max(200), prompt: z.string().trim().min(1).max(100000) }).strict().parse(input);
    const values = store.promptTemplates();
    const old = parsed.id ? current({ id: parsed.id, version: parsed.version }) : null;
    const at = Date.now();
    const value = { id: old?.id || randomUUID(), name: parsed.name, prompt: parsed.prompt, version: (old?.version || 0) + 1, createdAt: old?.createdAt || at, updatedAt: at };
    store.replacePromptTemplates(old ? values.map(item => item.id === old.id ? value : item) : [...values, value]);
    return list();
  }
  function remove(input) {
    const source = current(input);
    const count = references(source.id).length;
    if (count) throw new Error(`此模板被 ${count} 个任务引用，请先解除引用。`);
    store.replacePromptTemplates(store.promptTemplates().filter(value => value.id !== source.id));
    return list();
  }
  function preview(input) {
    const source = current(input);
    return { source, tasks: references(source.id).map(task => ({ ...task, needsUpdate: task.appliedVersion !== source.version || task.prompt !== source.prompt })) };
  }
  function publish(input) {
    const parsed = z.object({ id: z.string().min(1), version: z.number().int().positive(), targets: z.array(z.object({ templateId: z.string().min(1), taskId: z.string().min(1), fingerprint: z.string().min(1) }).strict()).min(1) }).strict().parse(input);
    const source = current({ id: parsed.id, version: parsed.version });
    const refs = references(source.id);
    const updates = parsed.targets.map(target => {
      const task = refs.find(value => value.templateId === target.templateId && value.taskId === target.taskId);
      if (!task || task.fingerprint !== target.fingerprint) throw new Error("引用任务已变更，请重新预览后发布。");
      return { templateId: target.templateId, taskId: target.taskId, fields: { prompt: source.prompt, promptTemplateVersion: source.version, promptTemplateSnapshot: source.prompt } };
    });
    store.publishPrompts(updates);
    return { updatedCount: updates.length };
  }
  return { listPromptTemplates: list, savePromptTemplate: save, deletePromptTemplate: remove, previewPromptPublish: preview, publishPromptTemplate: publish };
}
module.exports = { createPromptTemplateService };
