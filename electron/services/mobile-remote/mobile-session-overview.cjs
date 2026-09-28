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

function graphicalOverview(session, snapshot) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const recent = items.findLast(item => ["agentMessage", "userMessage"].includes(item.type) && item.text?.trim());
  const status = connectionState(session)
    || (snapshot?.approvals?.length || snapshot?.questions?.length || snapshot?.pendingPlan ? "待确认"
      : snapshot?.error ? "错误" : snapshot?.busy ? "处理中" : "空闲");
  return { sessionId: session.id, status, summary: cleanSummary(recent?.text) || fallbackSummary(session) };
}

async function terminalOverview(session, stateHub) {
  const output = await stateHub.getText?.(session.id, 2);
  const recent = String(output || "").split(/\r?\n/).filter(line => line.trim()).at(-1);
  return { sessionId: session.id, status: connectionState(session) || "运行中",
    summary: cleanSummary(recent) || fallbackSummary(session) };
}

async function sessionOverview(session, graphicalService, stateHub) {
  if (session.runtimeMode !== "app-server") {
    try { return await terminalOverview(session, stateHub); }
    catch { return { sessionId: session.id, status: connectionState(session) || "运行中", summary: fallbackSummary(session) }; }
  }
  try { return graphicalOverview(session, graphicalService?.snapshot(session.id)); }
  catch { return { sessionId: session.id, status: connectionState(session) || "空闲", summary: fallbackSummary(session) }; }
}

module.exports = { cleanSummary, graphicalOverview, terminalOverview, sessionOverview };
