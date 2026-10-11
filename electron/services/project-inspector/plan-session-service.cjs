const { assertStage } = require("./template-config.cjs");
const { createApprovalService } = require("./approval-service.cjs");

function createPlanSessionService({ store, launcher, router, terminalManager, sessionStore, onEvent = () => {} }) {
  const opening = new Map();
  let closed = false;
  const adapter = {
    createPlanningSession: input => launcher.createSession({ ...assertStage(input.project, "planning"), type: "windows", title: input.title, cwd: input.cwd,
      agentProvider: "codex", graphicalSessionEnabled: true, codexExperimentalAcknowledged: true,
      inspectorStage: "planning", inspectorFindingId: input.findingId, inspectorLinkId: input.linkId, persist: true }),
    setExecutionPermission: (id, permission) => router.setExecutionPermission(id, permission),
    setMode: (id, mode) => router.setMode(id, mode), snapshot: id => router.snapshot(id),
    submit: (id, prompt) => router.submit(id, prompt),
    close: async id => { router.close(id); const session = terminalManager.getSession(id); terminalManager.closeSession(id); if (session?.templateId) terminalManager.deleteSavedSession(session.templateId); }
  };
  const approvals = createApprovalService({ store, adapter, onEvent });
  function sync() {
    for (const link of store.list("sessions")) {
      if (link.stage !== "planning" || !["active", "completed"].includes(link.status) || !link.sessionId) continue;
      const session = terminalManager.getSession(link.sessionId) || terminalManager.listSessions().find(item => item.inspectorLinkId === link.id);
      if (!session) continue;
      if (session.id !== link.sessionId) {
        store.transaction(() => {
          store.put("sessions", { ...link, sessionId: session.id });
          const finding = store.get("findings", link.findingId);
          if (finding) store.put("findings", { ...finding, planSessionId: session.id });
        });
        link.sessionId = session.id;
      }
      if (link.status === "completed") continue;
      const snapshot = router.snapshot(session.id);
      if (!snapshot || snapshot.busy || snapshot.turnStatus !== "completed") continue;
      const plans = (snapshot.items || []).filter(item => item.type === "plan" || item.type === "agentMessage");
      const output = plans.map(item => item.text || "").filter(Boolean).join("\n\n");
      if (!output) continue;
      const now = Date.now();
      store.transaction(() => {
        store.put("sessions", { ...link, status: "completed", threadId: snapshot.threadId, planOutput: output, completedAt: now });
        const finding = store.get("findings", link.findingId);
        if (finding?.status === "planning") store.put("findings", { ...finding, status: "awaiting_implementation", revision: finding.revision + 1, updatedAt: now });
      });
      onEvent({ type: "plan-completed", projectId: link.projectId, data: { findingId: link.findingId, sessionId: link.sessionId } });
    }
  }
  function getPlan(findingId) {
      if (typeof findingId !== "string" || !findingId || findingId.length > 100) throw new Error("问题 ID 无效。");
      const finding = store.get("findings", findingId);
      if (!finding) throw new Error("问题不存在。");
      if (!closed) sync();
      return store.list("sessions", finding.projectId).find(link => link.findingId === findingId && link.stage === "planning" && ["active", "completed"].includes(link.status)) || null;
  }
  function openPlan(findingId) {
    if (closed) return Promise.reject(new Error("规划服务已关闭。"));
    if (opening.has(findingId)) return opening.get(findingId);
    const operation = (async () => {
      sync();
      const link = getPlan(findingId);
      if (!link) throw new Error("没有可查看的规划会话。");
      if (terminalManager.getSession(link.sessionId)) return link;
      const template = link.templateId && sessionStore?.getTemplate(link.templateId);
      if (!template || template.inspectorStage !== "planning" || template.inspectorLinkId !== link.id || !template.inspectorThreadId)
        throw new Error("规划会话的关联模板不可用，请检查会话库。");
      const session = await launcher.launchSession(template);
      const updated = { ...link, sessionId: session.id };
      store.transaction(() => {
        store.put("sessions", updated);
        const finding = store.get("findings", findingId);
        store.put("findings", { ...finding, planSessionId: session.id });
      });
      return updated;
    })().finally(() => opening.delete(findingId));
    opening.set(findingId, operation);
    return operation;
  }
  return { approvePlanning: approvals.approvePlanning, sync, getPlan, openPlan,
    async close() { closed = true; await approvals.close(); await Promise.allSettled([...opening.values()]); }
  };
}
module.exports = { createPlanSessionService };
