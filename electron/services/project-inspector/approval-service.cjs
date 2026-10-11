const { assertStage } = require("./template-config.cjs");
const { randomUUID } = require("node:crypto");
const { resolveProject, redact } = require("./project-profiler.cjs");

function renderPlanPrompt(finding, project) {
  return [
    "你是本问题的改造规划 Agent，只能执行只读分析，不允许修改、删除、提交、推送代码。",
    `问题 ID：${finding.id}`, `问题标题：${finding.title}`, `类型/等级：${finding.type}/${finding.severity}`,
    `仓库：${project.rootPath}`, `证据 commit：${finding.headCommit}`,
    "本次规划以问题关联的已提交 Git 证据为基线，不纳入或修改未提交更改。",
    `代码位置：${finding.location.path}:${finding.location.startLine}-${finding.location.endLine}`,
    `置信度：${finding.confidence}；验证情况：${finding.verification}`,
    `完整证据：\n${JSON.stringify(finding.evidence, null, 2)}`,
    `影响：${finding.impact}`, `建议：${finding.recommendation}`,
    "任务：先独立复核问题，并指出证据不足之处；说明影响模块、兼容性风险与回归范围；输出分步骤方案、建议变更文件、测试与验收清单。",
    "不执行代码修改。规划批准仅授权本次只读规划；实施需要在项目巡检中单独批准，将使用隔离工作树。"
  ].join("\n");
}

// Adapter must start a dedicated session with inspector safety controls. Merely
// accepting a readOnly prompt is insufficient; the snapshot is checked before submit.
function createApprovalService({ store, adapter, inspectProject = resolveProject, onEvent = () => {} }) {
  const operations = new Map();
  let closed = false;
  function record(table, id) {
    if (typeof id !== "string" || !id || id.length > 100) throw new Error("审批 ID 无效。");
    const value = store.get(table, id);
    if (!value) throw new Error("审批对象不存在。");
    return value;
  }
  async function performPlanning(input) {
    if (closed) throw new Error("审批服务已关闭。");
    const finding = record("findings", input.findingId);
    const existing = store.list("sessions", finding.projectId).find(session => session.findingId === finding.id && session.stage === "planning" && ["active", "completed"].includes(session.status));
    if (existing) return existing;
    if (finding.revision !== input.expectedRevision) throw new Error("问题已更新，请刷新后审批。");
    if (!["awaiting_review", "deferred"].includes(finding.status)) throw new Error("当前问题不能进入规划。");
    const interrupted = store.list("sessions", finding.projectId).find(session => session.findingId === finding.id && session.stage === "planning" && session.status === "interrupted" && session.sessionId);
    if (interrupted) throw new Error("前次规划创建中断，请先核查关联会话，避免重复提交。");
    const project = record("projects", finding.projectId);
    assertStage(project, "planning");
    const current = await inspectProject(project.rootPath);
    if (current.rootPath.toLowerCase() !== project.rootPath.toLowerCase() || current.headCommit !== finding.headCommit) throw new Error("Git 版本已变化，请重新巡检后规划。");

    if (!adapter) throw new Error("受控 Codex 规划适配器不可用。");
    const approvalId = randomUUID();
    const link = { id: randomUUID(), projectId: project.id, findingId: finding.id, stage: "planning", provider: "codex", mode: "plan", executionPermission: "readOnly", status: "creating", approvedHeadCommit: current.headCommit, sourceDirtyAtApproval: current.dirty, createdAt: Date.now() };
    store.transaction(() => {
      const latest = record("findings", finding.id);
      if (latest.revision !== input.expectedRevision) throw new Error("问题在审批期间已更新。");
      store.put("approvals", { id: approvalId, projectId: project.id, findingId: finding.id, stage: "planning", decision: "pending", reviewer: "local-user", createdAt: Date.now() });
      store.put("sessions", link);
    });
    let session;
    try {
      session = await adapter.createPlanningSession({ project, cwd: project.rootPath, title: input.title || `Plan · ${finding.title}`, findingId: finding.id, linkId: link.id });
      if (!session?.id) throw new Error("未返回新会话 ID。");
      store.put("sessions", { ...link, sessionId: session.id, templateId: session.templateId || null });
      await adapter.setExecutionPermission(session.id, "readOnly");
      await adapter.setMode(session.id, "plan");
      const snapshot = await adapter.snapshot(session.id);
      if (!snapshot?.threadId || snapshot.executionPermission !== "readOnly" || snapshot.mode !== "plan" || snapshot.permissionError || snapshot.inspectorSafety !== "enforced") throw new Error("无法确认只读 Plan 与工具隔离，已终止规划。");
      const rechecked = await inspectProject(project.rootPath);
      const latest = record("findings", finding.id);
      if (rechecked.headCommit !== current.headCommit || latest.revision !== input.expectedRevision) throw new Error("审批期间代码或问题已变化，已终止规划。");
      // Keep creating until submission succeeds. Never silently retry a prompt.
      await adapter.submit(session.id, renderPlanPrompt(finding, project));
      const completed = { ...link, sessionId: session.id, templateId: session.templateId || null, threadId: snapshot.threadId, status: "active", submittedAt: Date.now() };
      store.transaction(() => {
        store.put("sessions", completed);
        store.put("approvals", { ...record("approvals", approvalId), decision: "approved", sessionId: session.id });
        store.put("findings", { ...latest, status: "planning", planSessionId: session.id, revision: latest.revision + 1, updatedAt: Date.now() });
      });
      onEvent({ type: "planning", projectId: project.id, data: completed });
      return completed;
    } catch (error) {
      if (session?.id) { try { await adapter.close(session.id); } catch { /* Failed links remain auditable. */ } }
      store.transaction(() => {
        store.put("sessions", { ...link, sessionId: session?.id || null, status: "failed", error: redact(String(error.message)).replaceAll(project.rootPath, "[项目目录]").slice(0, 2000) });
        store.put("approvals", { ...record("approvals", approvalId), decision: "failed" });
      });
      throw error;
    }
  }
  function approvePlanning(input) {
    if (!input || typeof input.findingId !== "string" || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1
      || (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200))) return Promise.reject(new Error("规划审批参数无效。"));
    if (operations.has(input.findingId)) return operations.get(input.findingId);
    const operation = performPlanning(input).finally(() => operations.delete(input.findingId));
    operations.set(input.findingId, operation);
    return operation;
  }
  async function close() { closed = true; await Promise.allSettled([...operations.values()]); }
  return { approvePlanning, close };
}
module.exports = { createApprovalService, renderPlanPrompt };
