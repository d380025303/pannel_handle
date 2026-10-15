const { z } = require("zod");
const { canCloseCompleted } = require("../mobile-remote/mobile-session-overview.cjs");
const condition = z.lazy(() => z.union([
  z.object({ kind: z.literal("group"), operator: z.enum(["and", "or"]), children: z.array(condition).min(1).max(50) }).strict(),
  z.object({ kind: z.literal("condition"), field: z.enum(["templateId", "ownerId", "taskName", "output", "needsFollowUp"]), operator: z.enum(["equals", "notEquals", "contains", "notContains"]), value: z.string().min(1).max(1000) }).strict()
]));
const ruleSchema = z.object({ id: z.string().min(1).max(100), name: z.string().trim().min(1).max(100), enabled: z.boolean(), condition,
  prompt: z.string().max(100000) }).strict();
function validateRule(value) {
  function depth(node, level = 1) {
    if (level > 5) throw new Error("条件最多嵌套 5 层。");
    if (node.kind === "group") {
      if (!Array.isArray(node.children)) throw new Error("条件组无效。");
      for (const child of node.children) depth(child, level + 1);
    }
  }
  depth(value.condition);
  const rule = ruleSchema.parse(value);
  function fields(node) {
    if (node.kind === "group") return node.children.forEach(fields);
    if (["templateId", "ownerId", "needsFollowUp"].includes(node.field) && !["equals", "notEquals"].includes(node.operator)) throw new Error("来源和后续处理条件只支持等于或不等于。");
    if (node.field === "needsFollowUp" && !["true", "false"].includes(node.value)) throw new Error("后续处理条件无效。");
  }
  fields(rule.condition);
  if (/{{(?!output}}|taskName}}|ownerName}}|templateName}})[^}]*}}/.test(rule.prompt)) throw new Error("提示词包含不支持的变量。");
  return rule;
}
function matches(node, item) {
  if (node.kind === "group") return node.operator === "and" ? node.children.every(child => matches(child, item)) : node.children.some(child => matches(child, item));
  const value = String(item[node.field] ?? "");
  return ({ equals: () => value === node.value, notEquals: () => value !== node.value, contains: () => value.includes(node.value), notContains: () => !value.includes(node.value) })[node.operator]();
}
function expandPrompt(rule, item) {
  const variables = { output: item.output, taskName: item.taskName, ownerName: item.owner.name, templateName: item.template.title };
  return rule.prompt.trim() ? rule.prompt.replace(/{{(output|taskName|ownerName|templateName)}}/g, (_, key) => variables[key]) : item.output;
}
function createWorkItemAutomation({ dataStore, workItems, busy, terminalManager, graphicalService, getSessionApi, broadcast, notify = () => {}, getAgentStatus, closeSession = id => terminalManager.closeSession(id) }) {
  let enabled = false; let ticking = false; let active; let waiting = "";
  const changed = () => broadcast("work-items:changed");
  function alert(run, error) {
    if (!error || run.errors.has(error)) return;
    run.errors.add(error); run.hadError = true;
    try { dataStore.patchAutomationAttempt(run.item.id, run.attemptId, { hadError: true, automationError: [...run.errors].join(" · ") }); } catch { /* Retry persistence before considering closure. */ }
    try { notify({ taskName: run.item.taskName, sessionId: run.sessionId, error }); } catch { /* Notification delivery must not affect task tracking. */ }
    changed();
  }
  async function finish(run) {
    const attempt = dataStore.getWorkItemAttempt(run.item.id, run.attemptId);
    run.sessionId = attempt.sessionId;
    if (["creating", "running", "uncertain"].includes(attempt.status)) { waiting = attempt.status === "uncertain" ? "执行结果待核对，自动化已暂停" : "正在执行自动任务"; return; }
    if (attempt.status !== "completed" || attempt.error || run.hadError) {
      if (attempt.status !== "completed" || attempt.error) alert(run, attempt.error || "执行未成功结束，请检查会话。");
      dataStore.patchAutomationAttempt(run.item.id, run.attemptId, { closeResult: "保留会话：最终执行失败或结果处理失败", hadError: run.hadError, automationError: [...run.errors].join(" · ") }); active = null; return;
    }
    const session = terminalManager.getSession(attempt.sessionId);
    if (!session) { active = null; return; }
    const snapshot = graphicalService.snapshot(attempt.sessionId);
    const identity = graphicalService.getInjectedToolState(attempt.sessionId);
    if (snapshot.error) { alert(run, snapshot.error); return; }
    if (identity?.threadId !== attempt.threadId || (identity?.turnId || identity?.completedTurnId) !== attempt.turnId) {
      dataStore.patchAutomationAttempt(run.item.id, run.attemptId, { closeResult: "保留会话：已进入其他回合" }); active = null; return;
    }
    if (!canCloseCompleted(session, graphicalService, getAgentStatus?.(attempt.sessionId)) || snapshot.elicitations?.length) { waiting = "等待关联会话完成，确认或审批期间不会关闭"; return; }
    // Save the output and close decision before closing the instance.
    dataStore.patchAutomationAttempt(run.item.id, run.attemptId, { closeResult: "准备关闭" });
    try { await closeSession(attempt.sessionId); dataStore.patchAutomationAttempt(run.item.id, run.attemptId, { closeResult: "已自动关闭" }); }
    catch (error) { alert(run, `自动关闭失败：${error.message}`); dataStore.patchAutomationAttempt(run.item.id, run.attemptId, { closeResult: "自动关闭失败，保留会话" }); }
    active = null; changed();
  }
  async function tick() {
    if (!enabled || ticking || !dataStore) return;
    ticking = true;
    try {
      if (active) { await finish(active); return; }
      if (dataStore.automationUncertain?.()) { waiting = "自动任务执行结果待核对，自动化已暂停"; return; }
      const rules = dataStore.getAutomationState().rules.filter(rule => rule.enabled);
      waiting = "";
      if (!rules.length) return;
      if (!getSessionApi()?.status().running) { waiting = "等待 HTTP 接口服务启动"; return; }
      for (const item of dataStore.automationCandidates()) {
        const rule = rules.find(rule => matches(rule.condition, item));
        if (!rule) continue;
        if (busy(item.templateId, item.ownerId) || dataStore.workItemOwnerBusy(item.templateId, item.ownerId)) { waiting = "等待负责人空闲"; continue; }
        const run = { item, errors: new Set(), hadError: false };
        try {
          await workItems.executeAutomation({ id: item.id, version: item.version, prompt: expandPrompt(rule, item) }, rule, (attempt, job) => {
            run.attemptId = attempt.id; if (job?.sessionId) run.sessionId = job.sessionId; active = run;
            // Only persistence failures are fatal before the final result is known.
            const error = job?.progressError;
            if (error) alert(run, error);
          });
        } catch (error) {
          // A transport error may leave an already submitted task running or uncertain.
          // Its persisted final status, rather than this exception, determines failure.
          if (!run.attemptId) {
            const latest = dataStore.getWorkItem(item.id);
            if (latest.status === "pending" && latest.version === item.version) {
              // Record preflight failures too, so a bad template cannot retry every second.
              const attempt = dataStore.startWorkItemAttempt(item.id, item.version, { prompt: expandPrompt(rule, item) }, {}, rule);
              run.attemptId = attempt.id; active = run;
              dataStore.updateWorkItemAttempt(item.id, attempt.id, { status: "failed", error: error.message, endedAt: Date.now() });
              alert(run, error.message);
            }
          }
        }
        if (active) break;
      }
    } catch (error) {
      waiting = error.message;
      if (active) alert(active, `自动化处理失败：${error.message}`);
    } finally { ticking = false; }
  }
  function getAutomation() { return { ...dataStore.getAutomationState(), waiting }; }
  function saveAutomation(input) {
    const value = z.object({ revision: z.number().int().min(0), rules: z.array(z.unknown()).max(100) }).strict().parse(input);
    const rules = value.rules.map(validateRule);
    if (new Set(rules.map(rule => rule.id)).size !== rules.length) throw new Error("规则 ID 重复。");
    const result = dataStore.saveAutomationState({ ...value, rules }); changed(); void tick(); return { ...result, waiting };
  }
  function previewAutomation(input) {
    const rule = validateRule(input);
    const items = dataStore.automationCandidates().filter(item => matches(rule.condition, item));
    return { total: items.length, samples: items.slice(0, 5).map(item => ({ id: item.id, taskName: item.taskName, prompt: expandPrompt(rule, item) })) };
  }
  const timer = setInterval(() => void tick(), 1000); timer.unref?.();
  return { getAutomation, saveAutomation, previewAutomation, tick, start: () => { enabled = true; void tick(); }, shutdown: () => { enabled = false; clearInterval(timer); } };
}
module.exports = { validateRule, matches, expandPrompt, createWorkItemAutomation };
