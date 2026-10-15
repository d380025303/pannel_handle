const { canCloseCompleted } = require("../mobile-remote/mobile-session-overview.cjs");

// Keep each run independently: the scheduler may replace its latest job before closure.
function createTaskSessionAutoClose({ terminalManager, graphicalService, getAgentStatus, closeSession = id => terminalManager.closeSession(id), notify = () => {} }) {
  const runs = new Set();
  let ticking = false; let stopped = false;
  function error(job, message) {
    if (!runs.has(job) || !message) return;
    job.closeErrors ||= new Set();
    if (job.closeErrors.has(message)) return;
    job.closeErrors.add(message);
    job.hadCloseError = true;
    try { notify({ taskName: job.taskName, sessionId: job.sessionId, error: message }); } catch { /* Retain even if notification fails. */ }
  }
  const unsubscribe = graphicalService.onTaskError?.(event => {
    for (const job of runs) {
      if (job.sessionId === event.sessionId && (!event.threadId || event.threadId === job.threadId)) error(job, event.error);
    }
  });
  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      for (const job of runs) {
        try {
          if (job.hadCloseError || ["failed", "stopped"].includes(job.status)) { runs.delete(job); continue; }
          if (!job.sessionId) continue;
          const session = terminalManager.getSession(job.sessionId);
          if (!session) { runs.delete(job); continue; }
          const snapshot = graphicalService.snapshot(job.sessionId);
          if (snapshot?.error) { error(job, snapshot.error); runs.delete(job); continue; }
          if (job.status !== "completed" || job.creating || !job.output?.trim()) continue;
          if (job.historyDirty || job.historyError || job.resultError || job.progressError) continue;
          const identity = graphicalService.getInjectedToolState(job.sessionId);
          if (identity?.threadId !== job.threadId || (identity?.turnId || identity?.completedTurnId) !== job.turnId) { runs.delete(job); continue; }
          if (!canCloseCompleted(session, graphicalService, getAgentStatus?.(job.sessionId)) || snapshot?.elicitations?.length) continue;
          // Remove before awaiting to guarantee one close attempt per instance.
          runs.delete(job);
          try { await closeSession(job.sessionId); }
          catch (failure) {
            runs.add(job); error(job, `自动关闭失败：${failure.message}`); runs.delete(job);
          }
        } catch (failure) { error(job, `自动关闭检查失败：${failure.message}`); runs.delete(job); }
      }
    } finally { ticking = false; }
  }
  return { track: job => { if (job.autoCloseSession) runs.add(job); }, error, tick,
    shutdown: () => { stopped = true; unsubscribe?.(); runs.clear(); } };
}
module.exports = { createTaskSessionAutoClose };
