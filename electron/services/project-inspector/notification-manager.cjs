function createInspectorNotificationManager({ store, Notification, windowManager, onOpenProject, delayMs = 2000, logger = console }) {
  const timers = new Map(); const shown = new Map(); let closed = false;
  function schedule(id) {
    if (closed || timers.has(id)) return;
    const timer = setTimeout(() => { timers.delete(id); flush(id); }, delayMs);
    timer.unref?.(); timers.set(id, timer);
  }
  function flush(id) {
    if (closed) return;
    const project = store.get("projects", id);
    if (!project?.pendingNotificationIds?.length) return;
    if (store.list("runs", id).some(run => ["queued", "running"].includes(run.status))) { schedule(id); return; }
    const findings = project.pendingNotificationIds.map(key => store.get("findings", key)).filter(item => item && item.status === "awaiting_review");
    store.put("projects", { ...project, pendingNotificationIds: [], lastNotificationAt: Date.now() });
    if (!project.settings?.notifications || !findings.length || windowManager.isMainWindowFocused() || !Notification.isSupported()) return;
    try {
      shown.get(id)?.close();
      const high = findings.filter(item => ["P0", "P1"].includes(item.severity)).length;
      const notification = new Notification({ title: "项目巡检发现待复核问题", body: `${project.name}：${findings.length} 个新增或重新打开的问题，其中 ${high} 个高优先级。` });
      shown.set(id, notification);
      notification.on("click", () => { windowManager.focusWindow(); onOpenProject(id); });
      notification.on("close", () => { if (shown.get(id) === notification) shown.delete(id); });
      notification.show();
    } catch { logger.error("Project inspection notification could not be shown."); }
  }
  function handleEvent(event) {
    if (closed || event.type !== "findings" || !event.data?.notificationIds?.length) return;
    const project = store.get("projects", event.projectId);
    if (!project?.settings?.notifications) return;
    const ids = [...new Set([...(project.pendingNotificationIds || []), ...event.data.notificationIds])].slice(0, 1000);
    store.put("projects", { ...project, pendingNotificationIds: ids }); schedule(project.id);
  }
  for (const project of store.list("projects")) if (project.pendingNotificationIds?.length) schedule(project.id);
  return { handleEvent, flush,
    close() { closed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); for (const notification of shown.values()) notification.close(); shown.clear(); }
  };
}
module.exports = { createInspectorNotificationManager };
