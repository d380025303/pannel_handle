const { z } = require("zod");
const ACTIVE = ["creating", "running", "uncertain"];
const statusSchema = z.enum(["pending", ...ACTIVE, "completed", "failed", "stopped", "void"]);
const identity = z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict();
const execution = identity.extend({ prompt: z.string().refine(value => Boolean(value.trim()), "提示词不能为空。").optional() });

function createWorkItemService({ dataStore, template, supported, owners, busy, prepare, launch, terminalManager, graphicalService, getSessionApi, broadcast, retire, storageErrors = () => [] }) {
  function database() {
    if (!dataStore) throw new Error("SQLite 任务存储不可用。");
    return dataStore;
  }
  const changed = () => broadcast("work-items:changed");
  function availability(item, ownerIds = id => new Set(owners(id).map(owner => owner.id))) {
    let value;
    try { value = template(item.templateId); } catch { return "来源模板已删除。"; }
    if (!supported(value)) return "来源模板不再支持本机 Windows Codex 图形会话。";
    if (!ownerIds(item.templateId).has(item.ownerId)) return "来源负责人已删除。";
    return "";
  }
  function list(input = {}) {
    const query = z.object({ templateId: z.string().min(1).optional(), ownerId: z.string().min(1).optional(), status: statusSchema.optional(), statuses: z.array(statusSchema).max(8).optional(),
      needsFollowUp: z.boolean().optional(), keyword: z.string().trim().max(1000).optional(), page: z.number().int().min(0).max(1000000).default(0) }).strict().parse(input);
    const result = database().listWorkItems(query);
    const ownersByTemplate = new Map();
    const ownerIds = id => {
      if (!ownersByTemplate.has(id)) ownersByTemplate.set(id, new Set(owners(id).map(owner => owner.id)));
      return ownersByTemplate.get(id);
    };
    const templates = result.templates.map(value => {
      try { template(value.id); return value; } catch { return { ...value, name: `${value.name}（已删除）` }; }
    });
    const ownerOptions = result.owners.map(value => ({ ...value, name: ownerIds(value.templateId).has(value.id) ? value.name : `${value.name}（已删除）` }));
    return { ...result, templates, owners: ownerOptions, storageErrors: storageErrors(), records: result.records.map(item => ({ ...item, unavailable: availability(item, ownerIds) })) };
  }
  function get(input) {
    const { id } = z.object({ id: z.string().min(1) }).strict().parse(input);
    const item = database().getWorkItem(id);
    return { ...item, unavailable: availability(item) };
  }
  function preview(input) {
    const { id, prompt } = execution.parse(input);
    const item = database().getWorkItem(id);
    const unavailable = availability(item);
    if (unavailable) throw new Error(unavailable);
    const task = { ownerId: item.ownerId, tools: item.tools, name: item.taskName, manual: true };
    const body = prepare(item.templateId, { mode: "default", prompt: (prompt ?? item.output).trim() }, task);
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 256 * 1024 - 256) throw new Error("回复和上下文超过创建接口的 256 KiB 限制；原始回复已保留，无法执行。");
    const value = template(item.templateId);
    const configuration = Object.fromEntries(["title", "cwd", "agentProvider", "modelSource", "codexBackend", "modelId", "codexAppServerModel", "codexModel"].map(key => [key, value[key]]));
    return { body, configuration };
  }
  async function execute(input) {
    const { id, version } = execution.parse(input);
    const item = database().getWorkItem(id);
    const prepared = preview(input);
    if (!getSessionApi().status().running) throw new Error("请先开启 HTTP 接口服务。");
    if (busy(item.templateId, item.ownerId) || database().workItemOwnerBusy(item.templateId, item.ownerId)) throw new Error("此负责人有创建中、执行中或待核对的任务。");
    // This transaction happens before the first await, so other windows cannot submit twice.
    const attempt = database().startWorkItemAttempt(id, version, prepared.body, prepared.configuration);
    changed();
    let tracked = false;
    try {
      await launch(item.templateId, { mode: "default", prompt: prepared.body.prompt }, { id: attempt.id, ownerId: item.ownerId,
        name: item.taskName, tools: item.tools, manual: true, workItemId: item.id, onProgress: job => {
          tracked = true;
          database().updateWorkItemAttempt(id, attempt.id, { status: job.status, sessionId: job.sessionId, threadId: job.threadId, turnId: job.turnId,
            output: job.output || "", error: job.error || "", ...(ACTIVE.includes(job.status) ? {} : { endedAt: Date.now() }) });
          changed();
        } });
    } catch (error) {
      const saved = database().getWorkItemAttempt(id, attempt.id);
      if (!tracked && saved.status === "creating") database().updateWorkItemAttempt(id, attempt.id, { status: "failed", error: error.message, endedAt: Date.now() });
      changed();
      throw error;
    }
    return get({ id });
  }
  function markCompleted(input) {
    const { id, version } = identity.parse(input);
    database().markWorkItemCompleted(id, version);
    changed(); return get({ id });
  }
  function setFollowUp(input) {
    const { id, version, needsFollowUp } = identity.extend({ needsFollowUp: z.boolean() }).parse(input);
    database().setWorkItemFollowUp(id, version, needsFollowUp);
    changed(); return get({ id });
  }
  function change(input, operation) {
    const parsed = identity.extend({ reason: z.string().trim().max(2000).optional() }).parse(input);
    const item = database().changeWorkItem(parsed.id, parsed.version, operation, parsed.reason);
    changed(); return item;
  }
  function listAttempts(input) {
    const { id, page } = z.object({ id: z.string().min(1), page: z.number().int().min(0).max(1000000).default(0) }).strict().parse(input);
    return database().listWorkItemAttempts(id, page);
  }
  function getAttempt(input) {
    const { id, attemptId } = z.object({ id: z.string().min(1), attemptId: z.string().min(1) }).strict().parse(input);
    return database().getWorkItemAttempt(id, attemptId);
  }
  function resolveUncertain(input) {
    const { id, version } = identity.parse(input);
    const item = database().getWorkItem(id);
    if (item.version !== version || item.status !== "uncertain") throw new Error("任务已变更或并非待核对，请刷新。");
    const attempt = database().getWorkItemAttempt(id, item.latestAttemptId);
    const snapshot = attempt.sessionId && terminalManager.getSession(attempt.sessionId) ? graphicalService.snapshot(attempt.sessionId) : null;
    if (snapshot?.busy) throw new Error("关联会话仍在运行，请先结束原会话再核对。");
    if (!retire(attempt.id)) throw new Error("创建请求仍在处理，暂不能解除锁定。");
    database().updateWorkItemAttempt(id, attempt.id, { status: "stopped", endedAt: Date.now(), error: "人工核对原会话已结束或不存在，标记为中断。" });
    changed(); return get({ id });
  }
  function listQuickPrompts() { return database().listWorkItemPrompts(); }
  function mutateQuickPrompt(input) {
    const fields = { name: z.string().trim().min(1).max(100), prompt: z.string().min(1).max(100000).refine(value => Boolean(value.trim()), "提示词不能为空。") };
    const parsed = z.discriminatedUnion("operation", [
      z.object({ operation: z.literal("add"), ...fields }).strict(),
      z.object({ operation: z.literal("update"), ...identity.shape, ...fields }).strict(),
      z.object({ operation: z.literal("delete"), ...identity.shape }).strict()
    ]).parse(input);
    const records = database().mutateWorkItemPrompt(parsed);
    changed();
    return records;
  }
  return { listQuickPrompts, mutateQuickPrompt, list, get, preview, execute, markCompleted, setFollowUp, listAttempts, getAttempt, void: input => change(input, "void"), restore: input => change(input, "restore"), resolveUncertain };
}
module.exports = { createWorkItemService };
