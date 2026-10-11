const { assertStage } = require("./template-config.cjs");
const { randomUUID } = require("node:crypto");
const { resolveProject, redact } = require("./project-profiler.cjs");
const { createImplementationWorkspaceManager } = require("./implementation-workspace.cjs");

function createImplementationSessionService({ userData, store, planning, launcher, router, terminalManager, sessionStore,
  testRunner = require("./implementation-test-runner.cjs").createImplementationTestRunner(), inspector,
  workspaces = createImplementationWorkspaceManager({ userData }), inspectProject = resolveProject, onEvent = () => {} }) {
  const operations = new Map();
  const opening = new Map();
  const testControllers = new Set();
  let closed = false;
  function record(table, id) {
    if (typeof id !== "string" || !id || id.length > 100) throw new Error("实施记录 ID 无效。");
    const value = store.get(table, id);
    if (!value) throw new Error("实施记录不存在。");
    return value;
  }
  function sync() {
    if (closed) return;
    for (const link of store.list("sessions")) {
      if (link.stage === "implementation" && link.status === "merged" && link.reinspectionRunIds?.length && !link.reinspection) {
        const runs = link.reinspectionRunIds.map(id => store.get("runs", id));
        if (runs.some(run => run && ["queued", "running"].includes(run.status))) continue;
        const finding = record("findings", link.findingId);
        const completed = runs.filter(run => run?.status === "completed" && run.headCommit === link.merge.headCommit);
        const root = link.rootFinding || {};
        const supported = root.detectionEngine === "static" && ["electron-node-integration", "electron-context-isolation", "tls-verification-disabled", "empty-error-handler"].includes(root.ruleId);
        const covered = supported && completed.find(run => run.engine === "static" && !run.incremental && run.stats?.truncated === false && run.stats?.rejected === 0 && run.reviewedPaths?.includes(root.path));
        const matching = store.list("findings", link.projectId).some(item => link.reinspectionRunIds.includes(item.runId) && item.ruleId === root.ruleId && item.location?.path === root.path);
        const complete = runs.every(run => run && ["completed", "skipped"].includes(run.status) && run.headCommit === link.merge.headCommit);
        const resolved = complete && covered && !matching;
        const reinspection = { status: resolved ? "source_resolved" : "risk", headCommit: link.merge.headCommit, completedAt: Date.now(), runIds: link.reinspectionRunIds,
          summary: resolved ? "完整静态复检未再检出原规则。此结论仅覆盖源码规则，不等于运行时缺陷已复现并修复。" : matching ? "复检仍检出相同规则和文件的问题，需要继续复核。" : "复检证据不足以确认修复：请检查覆盖范围、巡检失败和运行时回归风险。" };
        store.transaction(() => {
          store.put("sessions", { ...link, reinspection });
          if (finding.status === "awaiting_reinspection") store.put("findings", { ...finding, status: resolved ? "resolved" : "reinspection_risk", revision: finding.revision + 1, updatedAt: Date.now(), repairVerification: reinspection });
        });
        onEvent({ type: "repair-reinspected", projectId: link.projectId, data: { findingId: finding.id, status: reinspection.status } });
      }
      if (link.stage !== "implementation" || link.status !== "active") continue;
      const runtime = terminalManager.getSession(link.sessionId) || terminalManager.listSessions().find(session => session.inspectorLinkId === link.id);
      if (!runtime) continue;
      const snapshot = router.snapshot(runtime.id);
      if (!snapshot || snapshot.busy || snapshot.turnStatus !== "completed" || snapshot.inspectorStage !== "implementation" || snapshot.inspectorSafety !== "enforced") continue;
      const output = (snapshot.items || []).filter(item => item.type === "agentMessage").map(item => item.text || "").filter(Boolean).join("\n\n");
      const timestamp = Date.now();
      store.transaction(() => {
        store.put("sessions", { ...link, status: "completed", sessionId: runtime.id, implementationOutput: output, completedAt: timestamp });
        const finding = record("findings", link.findingId);
        if (finding.status === "implementing") store.put("findings", { ...finding, status: "awaiting_diff_review", implementationSessionId: runtime.id, revision: finding.revision + 1, updatedAt: timestamp });
      });
      onEvent({ type: "implementation-completed", projectId: link.projectId, data: { findingId: link.findingId, sessionId: runtime.id } });
    }
  }
  function getImplementation(findingId) {
    const finding = record("findings", findingId);
    sync();
    return store.list("sessions", finding.projectId).filter(link => link.findingId === findingId && link.stage === "implementation")
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }
  async function approve(input) {
    if (closed) throw new Error("实施服务已关闭。");
    const finding = record("findings", input.findingId);
    const existing = getImplementation(finding.id);
    if (existing?.status === "active") return existing;
    if (existing?.workspace || ["creating", "interrupted"].includes(existing?.status)) throw new Error("已有实施工作树，请先检查关联记录，避免重复实施。");
    if (finding.revision !== input.expectedRevision || finding.status !== "awaiting_implementation") throw new Error("问题状态已变化，请刷新后审批实施。");
    const plan = planning.getPlan(finding.id);
    if (!plan || plan.status !== "completed" || !plan.planOutput || plan.id !== input.planId) throw new Error("必须先审阅本问题已完成的 Plan，再单独批准实施。");
    const project = record("projects", finding.projectId);
    const agentConfig = assertStage(project, "implementation");
    const current = await inspectProject(project.rootPath);
    if (current.headCommit !== plan.approvedHeadCommit || current.headCommit !== finding.headCommit || current.rootPath.toLowerCase() !== project.rootPath.toLowerCase()) throw new Error("规划基线已变化，请重新巡检和规划。");
    const approvalId = randomUUID();
    let link = { id: randomUUID(), projectId: project.id, findingId: finding.id, stage: "implementation", planId: plan.id,
      rootFinding: { ruleId: finding.ruleId, path: finding.location?.path, detectionEngine: finding.detectionEngine },
      approvedHeadCommit: current.headCommit, provider: "codex", status: "creating", mode: "default", executionPermission: "askApproval", createdAt: Date.now() };
    store.transaction(() => {
      if (record("findings", finding.id).revision !== input.expectedRevision) throw new Error("问题在审批期间已更新。");
      store.put("approvals", { id: approvalId, projectId: project.id, findingId: finding.id, stage: "implementation", decision: "pending", planId: plan.id, reviewer: "local-user", createdAt: Date.now() });
      store.put("sessions", link);
    });
    let session;
    try {
      const workspace = await workspaces.create(project.rootPath, current.headCommit);
      link = { ...link, workspace };
      store.put("sessions", link);
      if (closed || record("findings", finding.id).revision !== input.expectedRevision) throw new Error("实施准备期间问题已更新或应用正在关闭。");
      session = await launcher.createSession({ ...agentConfig, type: "windows", title: input.title || `实施 · ${finding.title}`, cwd: workspace.cwd,
        agentProvider: "codex", graphicalSessionEnabled: true, codexExperimentalAcknowledged: true,
        inspectorStage: "implementation", inspectorWorkspaceId: workspace.id, inspectorFindingId: finding.id, inspectorLinkId: link.id, persist: true });
      link = { ...link, sessionId: session.id, templateId: session.templateId || null };
      store.put("sessions", link);
      const snapshot = router.snapshot(session.id);
      if (!snapshot?.threadId || snapshot.inspectorStage !== "implementation" || snapshot.inspectorSafety !== "enforced" || snapshot.mode !== "default" || snapshot.executionPermission !== "askApproval" || snapshot.permissionError) throw new Error("无法确认实施工作树的写入边界，已停止实施。");
      await workspaces.assertWorkspace(workspace);
      const rechecked = await inspectProject(project.rootPath);
      const latest = record("findings", finding.id);
      if (closed || latest.revision !== input.expectedRevision || latest.status !== "awaiting_implementation" || rechecked.headCommit !== current.headCommit) throw new Error("实施审批期间基线或问题已变化。");
      await router.submit(session.id, ["你是本问题的实施 Agent。本次批准只允许在当前隔离工作树内实施已审阅的方案。",
        `工作树：${workspace.cwd}`, `基线：${current.headCommit}`, `问题：${finding.title} (${finding.id})`,
        `完整证据：\n${JSON.stringify(finding.evidence, null, 2)}`, `已批准 Plan：\n${plan.planOutput}`,
        "复核后按方案修改并运行相关测试，完整说明测试结果、失败原因和未验证范围。不要修改原工作区、Git 公共目录或外部目录，不要提交、合并、推送或扩大权限。",
        "实施完成后等待项目巡检中的差异审核、测试验收和独立合并审批。"].join("\n"));
      link = { ...link, status: "active", threadId: snapshot.threadId, submittedAt: Date.now() };
      store.transaction(() => {
        store.put("sessions", link);
        store.put("approvals", { ...record("approvals", approvalId), decision: "approved", sessionId: session.id, workspaceId: workspace.id });
        store.put("findings", { ...latest, status: "implementing", implementationSessionId: session.id, revision: latest.revision + 1, updatedAt: Date.now() });
      });
      onEvent({ type: "implementation-started", projectId: project.id, data: { findingId: finding.id, sessionId: session.id } });
      return link;
    } catch (error) {
      if (session?.id) { try { router.close(session.id); terminalManager.closeSession(session.id); } catch { /* Keep the approval failure and worktree auditable even when shutdown fails. */ } }
      // Preserve the worktree and its branch for inspection/recovery, including startup failures.
      store.transaction(() => {
        store.put("sessions", { ...link, status: "failed", error: redact(String(error.message)).slice(0, 2000) });
        store.put("approvals", { ...record("approvals", approvalId), decision: "failed" });
      });
      throw error;
    }
  }
  function approveImplementation(input) {
    if (!input || typeof input.findingId !== "string" || typeof input.planId !== "string" || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1
      || (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200))) return Promise.reject(new Error("实施审批参数无效。"));
    if (operations.has(input.findingId)) return operations.get(input.findingId);
    const operation = approve(input).finally(() => operations.delete(input.findingId));
    operations.set(input.findingId, operation);
    return operation;
  }
  function openImplementation(findingId) {
    if (closed) return Promise.reject(new Error("实施服务已关闭。"));
    if (opening.has(findingId)) return opening.get(findingId);
    const operation = (async () => {
      const link = getImplementation(findingId);
      if (link?.sealed) throw new Error("实施版本已封存供合并审核，不能重新开启写入会话。");
      if (!link?.workspace || !link.templateId || !["active", "completed"].includes(link.status)) throw new Error("没有可恢复的实施会话。");
      await workspaces.assertWorkspace(link.workspace);
      const active = terminalManager.getSession(link.sessionId) || terminalManager.listSessions().find(session => session.inspectorLinkId === link.id);
      const template = sessionStore?.getTemplate(link.templateId);
      if (!active && (!template || template.inspectorStage !== "implementation" || template.inspectorLinkId !== link.id || template.inspectorWorkspaceId !== link.workspace.id || !template.inspectorThreadId)) throw new Error("实施会话的关联模板不可用，请检查会话库。");
      const session = active || await launcher.launchSession(template);
      const updated = { ...link, sessionId: session.id };
      store.transaction(() => {
        store.put("sessions", updated);
        const finding = record("findings", findingId);
        store.put("findings", { ...finding, implementationSessionId: session.id });
      });
      return updated;
    })().finally(() => opening.delete(findingId));
    opening.set(findingId, operation);
    return operation;
  }
  async function reviewImplementation(findingId) {
    if (closed) throw new Error("实施服务已关闭。");
    const link = getImplementation(findingId);
    if (!link?.workspace) throw new Error("没有关联的实施工作树。");
    const runtimeIds = linkedRuntimeIds(link);
    if ([...runtimeIds].some(id => id && router.snapshot(id)?.busy)) throw new Error("实施仍在执行，请完成或停止后审查差异。");
    const review = await workspaces.review(link.workspace);
    store.put("sessions", { ...link, review });
    return { ...link, review };
  }
  async function assertSessionAllowed(session) {
    const link = record("sessions", session.inspectorLinkId);
    if (closed || link.stage !== "implementation" || link.sealed || !link.workspace || link.workspace.id !== session.inspectorWorkspaceId || link.findingId !== session.inspectorFindingId || link.workspace.cwd.toLowerCase() !== session.cwd.toLowerCase()) throw new Error("实施会话未获批准或已封存，不能开启写入。");
    const cwd = await workspaces.assertWorkspace(link.workspace);
    if (closed || record("sessions", link.id).sealed) throw new Error("实施版本已封存，不能开启写入。");
    return cwd;
  }
  function linkedRuntimeIds(link) {
    // Verification closes the writer. Its persisted ID is historical and the
    // graphical router throws for closed sessions instead of returning null.
    const ids = terminalManager.listSessions().filter(session => session.inspectorLinkId === link.id).map(session => session.id);
    if (link.sessionId && terminalManager.getSession(link.sessionId)) ids.push(link.sessionId);
    return new Set(ids);
  }
  function idle(link) {
    const ids = linkedRuntimeIds(link);
    if ([...ids].some(id => id && router.snapshot(id)?.busy)) throw new Error("实施仍在执行，请先完成或停止会话。");
    return ids;
  }
  function exclusive(input, operation) {
    if (closed || !input || typeof input.findingId !== "string" || !Number.isInteger(input.expectedRevision) || typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest)) return Promise.reject(new Error("实施验收参数无效。"));
    if (operations.has(input.findingId) || opening.has(input.findingId)) return Promise.reject(new Error("本问题正在处理，请稍后重试。"));
    const promise = operation().finally(() => operations.delete(input.findingId));
    operations.set(input.findingId, promise);
    return promise;
  }
  function verifyImplementation(input) {
    return exclusive(input, async () => {
      const finding = record("findings", input.findingId);
      let link = getImplementation(finding.id);
      if (finding.revision !== input.expectedRevision || !link?.workspace || !link.review || link.review.digest !== input.digest) throw new Error("请刷新问题并审查最新差异后执行验收。");
      const ids = idle(link);
      // Seal the persistent link first. Production App Server checks this record on
      // every startup, including duplicate templates and restored sessions.
      link = { ...link, sealed: true, verification: { status: "running", startedAt: Date.now() } };
      store.put("sessions", link);
      for (const id of ids) if (id) { router.close(id); if (terminalManager.getSession(id)) terminalManager.closeSession(id); }
      const controller = new AbortController();
      testControllers.add(controller);
      try {
        const committed = await workspaces.commit(link.workspace, input.digest);
        if (committed.dirty || committed.headCommit === link.workspace.baseCommit) throw new Error("实施没有干净的新提交，不能执行合并验收。");
        if (closed) controller.abort(new Error("应用正在关闭。"));
        const result = await testRunner({ cwd: link.workspace.cwd, signal: controller.signal });
        const review = await workspaces.review(link.workspace);
        const passed = result.passed === true && !review.dirty && review.headCommit === committed.headCommit;
        const verification = { ...result, status: passed ? "passed" : "failed", passed, headCommit: committed.headCommit };
        link = { ...link, status: passed ? "verified" : "completed", sealed: passed, verification, review };
        store.transaction(() => {
          store.put("sessions", link);
          const latest = record("findings", finding.id);
          if (latest.revision === input.expectedRevision) store.put("findings", { ...latest, status: passed ? "awaiting_merge" : "verification_failed", revision: latest.revision + 1, updatedAt: Date.now() });
        });
        onEvent({ type: "implementation-verified", projectId: finding.projectId, data: { findingId: finding.id, passed } });
        return link;
      } catch (error) {
        store.put("sessions", { ...link, sealed: false, verification: { status: "failed", passed: false, error: redact(String(error.message)).slice(0, 2000), completedAt: Date.now() } });
        throw error;
      } finally { testControllers.delete(controller); }
    });
  }
  function approveMerge(input) {
    return exclusive(input, async () => {
      const finding = record("findings", input.findingId);
      let link = getImplementation(finding.id);
      if (finding.revision !== input.expectedRevision || finding.status !== "awaiting_merge" || !link?.sealed || link.verification?.passed !== true || link.review?.digest !== input.digest || link.verification.headCommit !== link.review.headCommit) throw new Error("必须审阅当前差异和主进程测试结果，再独立批准合并。");
      idle(link);
      const approval = { id: randomUUID(), projectId: finding.projectId, findingId: finding.id, stage: "merge", decision: "pending", reviewer: "local-user", workspaceId: link.workspace.id, expectedHeadCommit: link.review.headCommit, testsPassed: true, createdAt: Date.now() };
      store.transaction(() => {
        store.put("approvals", approval);
        store.put("findings", { ...finding, status: "merging", revision: finding.revision + 1, updatedAt: Date.now() });
      });
      try {
        const result = await workspaces.merge(link.workspace, { ...approval, decision: "approved" });
        link = { ...link, status: "merged", merge: result };
        store.transaction(() => {
          store.put("sessions", link);
          store.put("approvals", { ...approval, decision: "approved", mergedAt: result.mergedAt });
          const latest = record("findings", finding.id);
          store.put("findings", { ...latest, status: "awaiting_reinspection", revision: latest.revision + 1, mergedCommit: result.headCommit, updatedAt: Date.now() });
        });
        try {
          if (!inspector) throw new Error("复检服务不可用，请手动重新巡检。");
          const runs = await inspector.startInspection({ projectId: finding.projectId, incremental: false });
          link = { ...link, reinspectionRunIds: runs.map(run => run.id) };
        } catch (error) { link = { ...link, reinspectionError: redact(String(error.message)).slice(0, 2000) }; }
        store.put("sessions", link);
        onEvent({ type: "implementation-merged", projectId: finding.projectId, data: { findingId: finding.id, headCommit: result.headCommit } });
        return link;
      } catch (error) {
        store.transaction(() => {
          store.put("approvals", { ...approval, decision: "failed", error: redact(String(error.message)).slice(0, 2000) });
          const latest = record("findings", finding.id);
          if (latest.status === "merging") store.put("findings", { ...latest, status: "awaiting_merge", revision: latest.revision + 1, updatedAt: Date.now() });
        });
        throw error;
      }
    });
  }
  return { approveImplementation, getImplementation, openImplementation, reviewImplementation, verifyImplementation, approveMerge, assertSessionAllowed, sync,
    async close() { closed = true; for (const controller of testControllers) controller.abort(new Error("应用正在关闭。")); await Promise.allSettled([...operations.values(), ...opening.values()]); } };
}
module.exports = { createImplementationSessionService };
