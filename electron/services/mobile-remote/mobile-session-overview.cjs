function canCloseCompleted(session, graphicalService, agentStatus) {
  const status = agentStatus || (session.agentStatus ? { status: session.agentStatus } : null);
  if (status?.status !== "completed" || ["AppServerPlanPending", "AppServerQuestion", "AcpQuestion"].includes(status.eventName)
    || status.resolution === "provide_input") return false;
  if (session.runtimeMode !== "app-server") return true;
  try {
    const snapshot = graphicalService?.snapshot(session.id);
    return Boolean(snapshot && !snapshot.busy && !snapshot.error && !snapshot.pendingPlan
      && !snapshot.approvals?.length && !snapshot.questions?.length);
  } catch { return false; }
}

function cleanSummary(value) {
  return String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

function fallbackSummary(session) {
  return cleanSummary([session.agentProvider, session.cwd].filter(Boolean).join(" · ")) || "暂无最近内容";
}

function connectionState(session) {
  if (session.type !== "ssh") return null;
  if (session.sshConnectionState === "connecting") return "连接中";
  if (session.sshConnectionState === "reconnecting") return "重连中";
  if (session.sshConnectionState === "disconnected") return "已断开";
  return null;
}

function agentDetail(agentStatus) {
  if (!agentStatus) return null;
  if (agentStatus.status === "waiting_for_permission") return "等待授权";
  if (agentStatus.resolution === "provide_input" || agentStatus.eventName === "AppServerQuestion") return "需要用户输入";
  if (agentStatus.eventName === "AppServerPlanPending") return "等待确认计划";
  if (agentStatus.status === "failed") return "执行失败";
  if (agentStatus.status === "running") return "运行中";
  if (agentStatus.status === "completed") return "已完成";
  if (agentStatus.status === "e_prompt") return "空闲";
  if (agentStatus.status === "ended") return "已结束";
  return null;
}

function graphicalOverview(session, snapshot, agentStatus) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const recent = items.findLast(item => ["agentMessage", "userMessage"].includes(item.type) && item.text?.trim());
  const question = snapshot?.questions?.[0]?.params?.questions?.[0]?.question;
  const approval = snapshot?.approvals?.[0];
  const pendingDetail = snapshot?.questions?.length ? "需要用户输入"
    : snapshot?.approvals?.length ? "等待授权"
      : snapshot?.pendingPlan ? "等待确认计划" : null;
  const status = connectionState(session)
    || (snapshot?.approvals?.length || snapshot?.questions?.length || snapshot?.pendingPlan ? "待确认"
      : snapshot?.error ? "错误" : snapshot?.busy ? "处理中" : "空闲");
  const detail = connectionState(session) ? null : pendingDetail || (snapshot?.error ? "执行失败"
    : snapshot?.busy ? null : ["e_prompt", "completed", "ended"].includes(agentStatus?.status) ? agentDetail(agentStatus) : null);
  const summary = cleanSummary(question || approval?.params?.reason || approval?.params?.command
    || (snapshot?.pendingPlan ? "确认执行计划" : "") || agentStatus?.activitySummary || recent?.text) || fallbackSummary(session);
  return { sessionId: session.id, status, ...(detail ? { detail } : {}), summary };
}

async function terminalOverview(session, stateHub, agentStatus) {
  const output = await stateHub.getText?.(session.id, 2);
  const recent = String(output || "").split(/\r?\n/).filter(line => line.trim()).at(-1);
  const detail = connectionState(session) ? null : agentDetail(agentStatus || (session.agentStatus
    ? { status: session.agentStatus } : null));
  const status = connectionState(session) || (["等待授权", "需要用户输入", "等待确认计划"].includes(detail) ? "待确认"
    : detail === "执行失败" ? "错误" : "运行中");
  return { sessionId: session.id, status,
    ...(detail ? { detail } : {}), summary: cleanSummary(agentStatus?.activitySummary || recent) || fallbackSummary(session) };
}

async function buildSessionOverview(session, graphicalService, stateHub, agentStatus) {
  if (session.runtimeMode !== "app-server") {
    try { return await terminalOverview(session, stateHub, agentStatus); }
    catch { return terminalOverview(session, {}, agentStatus); }
  }
  try { return graphicalOverview(session, graphicalService?.snapshot(session.id), agentStatus); }
  catch { return { sessionId: session.id, status: connectionState(session) || "空闲", summary: fallbackSummary(session) }; }
}

async function sessionOverview(session, graphicalService, stateHub, agentStatus) {
  const overview = await buildSessionOverview(session, graphicalService, stateHub, agentStatus);
  return { ...overview, canCloseCompleted: canCloseCompleted(session, graphicalService, agentStatus) };
}

module.exports = { canCloseCompleted, cleanSummary, graphicalOverview, terminalOverview, sessionOverview };
