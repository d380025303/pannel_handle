function cleanSummary(value) {
  return String(value || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
}

function createMascotNotifications({ terminalManager, graphicalService, openExternal, onChanged }) {
  const runs = new Map();
  const statuses = new Map();
  const seen = new Map();
  const submitting = new Set();
  const settleTimers = new Set();
  const queue = [];
  let serial = 0, revision = 0, timer, startedAt = 0, remaining = 15000, ready = false, paused = false, disposed = false;
  const snapshot = () => ({ revision, notification: queue[0]?.ready ? { ...queue[0].notification } : null, pendingCount: queue.length });
  const changed = () => { revision++; onChanged(snapshot()); };
  function stopTimer() {
    if (timer) remaining = Math.max(0, remaining - (Date.now() - startedAt));
    clearTimeout(timer); timer = undefined;
  }
  function schedule() {
    stopTimer();
    if (!ready || paused || !queue[0]?.ready || submitting.has(queue[0].notification.id)) return;
    startedAt = Date.now();
    timer = setTimeout(() => dismiss(queue[0]?.notification.id), remaining);
  }
  function dismiss(id) {
    if (!id || queue[0]?.notification.id !== id) return;
    stopTimer(); queue.shift(); ready = false; remaining = 15000; changed();
  }
  function setPresentation(id, isPaused) {
    if (!id || queue[0]?.notification.id !== id || !queue[0].ready) return;
    ready = true; paused = isPaused === true; schedule();
  }
  function suspend() { stopTimer(); ready = false; paused = false; }
  function source(id) {
    try {
      const value = graphicalService.snapshot(id);
      return { error: value?.error, messages: (value?.items || []).filter(item => ["agentMessage", "plan"].includes(item.type)).map(item => ({ ...item })) };
    } catch { return { messages: [] }; }
  }
  function pendingRequests(value) {
    const requests = [];
    if (value.pendingPlan) requests.push({ kind: "plan", requestId: value.pendingPlan.itemId,
      text: value.items?.find(item => item.id === value.pendingPlan.itemId)?.text || "" });
    for (const request of value.approvals || []) requests.push({ kind: "approval", requestId: request.requestId, request,
      items: (value.items || []).filter(item => item.id === request.params.itemId) });
    for (const request of value.questions || []) requests.push({ kind: "question", requestId: request.requestId, request });
    for (const request of value.elicitations || []) requests.push({ kind: "elicitation", requestId: request.requestId, request });
    return requests.map(request => ({ ...request, key: JSON.stringify([value.threadId, request.kind, request.requestId]) }));
  }
  function pendingStatus(request, previous, provider, id) {
    const status = { eventName: "AppServerTurn", ...previous, id, provider, timestamp: previous?.timestamp || Date.now() };
    if (request.kind === "plan") {
      status.status = provider === "codex" ? "completed" : "e_prompt";
      status.eventName = provider === "codex" ? "AppServerPlanPending" : previous?.eventName || "AcpTurn";
    } else if (request.kind === "approval") status.status = "waiting_for_permission";
    else {
      status.status = "e_prompt";
      status.eventName = provider === "codex" ? "AppServerQuestion" : "AcpQuestion";
    }
    return status;
  }
  function syncPending(id) {
    const session = terminalManager.getSession(id);
    if (session?.runtimeMode !== "app-server") return;
    let value;
    try { value = graphicalService.snapshot(id); }
    catch { removeSession(id); return; }
    const requests = pendingRequests(value);
    const keys = new Set(requests.map(request => request.key));
    let remembered = seen.get(id);
    if (!remembered) { remembered = new Set(); seen.set(id, remembered); }
    for (const key of remembered) if (!keys.has(key)) remembered.delete(key);
    const oldHead = queue[0];
    let dirty = false;
    for (let index = queue.length - 1; index >= 0; index--) {
      const notification = queue[index].notification;
      if (notification.sessionId === id && notification.action) {
        const request = requests.find(request => request.key === notification.action.key);
        if (!request) { queue.splice(index, 1); dirty = true; }
        else {
          const agentStatus = pendingStatus(request, statuses.get(id), value.provider || session.agentProvider || "codex", id);
          if (JSON.stringify(notification.action) !== JSON.stringify(request) || JSON.stringify(notification.agentStatus) !== JSON.stringify(agentStatus)) {
            notification.action = request; notification.agentStatus = agentStatus; dirty = true;
          }
        }
      }
    }
    for (const request of requests) {
      if (remembered.has(request.key)) continue;
      remembered.add(request.key);
      const agentStatus = pendingStatus(request, statuses.get(id), value.provider || session.agentProvider || "codex", id);
      queue.push({ ready: true, notification: { id: String(++serial), sessionId: id,
        sessionTitle: cleanSummary(session.title), status: "pending", agentStatus, action: request,
        summary: cleanSummary(agentStatus.activitySummary) || "暂无摘要", timestamp: agentStatus.timestamp } });
      dirty = true;
    }
    if (oldHead !== queue[0]) { stopTimer(); ready = false; remaining = 15000; }
    if (dirty) { changed(); schedule(); }
    return value;
  }
  async function processAction(notificationId, operation) {
    const entry = queue.find(entry => entry.notification.id === notificationId);
    if (!entry?.notification.action || !operation || typeof operation !== "object") throw new Error("待处理请求已失效。");
    const { sessionId, action } = entry.notification;
    const current = syncPending(sessionId);
    const request = current && pendingRequests(current).find(request => request.key === action.key);
    if (!request || !queue.includes(entry)) throw new Error("待处理请求已失效。");
    if (operation.type === "openUrl") {
      if (request.kind !== "elicitation" || request.request.params.mode !== "url") throw new Error("链接请求已失效。");
      const url = new URL(request.request.params.url);
      if (!["https:", "http:"].includes(url.protocol) || !openExternal) throw new Error("不支持的链接。");
      await openExternal(url.href); return;
    }
    if (request.request?.submitting) throw new Error("请求正在提交。");
    if (submitting.has(notificationId)) throw new Error("请求正在提交。");
    const methods = { plan: { execute: "executePlan", dismiss: "dismissPlan" }, approval: { approve: "resolveApproval" },
      question: { answer: "answerQuestion", cancel: "cancelQuestion" }, elicitation: { respond: "resolveElicitation" } };
    const method = methods[request.kind]?.[operation.type];
    if (!method) throw new Error("无效的处理操作。");
    if (operation.type === "approve") {
      const decision = operation.decision;
      const params = request.request.params;
      if (typeof decision !== "boolean" && typeof decision !== "string") throw new Error("无效的授权选择。");
      if (params.choices?.length && !params.choices.some(choice => choice.id === decision)) throw new Error("授权选择已失效。");
      if (current.provider === "codex" || !current.provider) {
        const allowed = params.availableDecisions || ["accept", "decline", "cancel", "acceptForSession", "acceptWithExecpolicyAmendment"];
        if (!allowed.some(value => value === decision || decision === "acceptWithExecpolicyAmendment" && value && typeof value === "object" && Object.hasOwn(value, decision))) throw new Error("授权选择已失效。");
        if (decision === "acceptWithExecpolicyAmendment" && (request.request.method !== "item/commandExecution/requestApproval" || !Array.isArray(params.proposedExecpolicyAmendment) || !params.proposedExecpolicyAmendment.length || !params.proposedExecpolicyAmendment.every(part => typeof part === "string" && part.trim()))) throw new Error("无效的命令规则。");
        if (decision === "cancel" && request.request.method === "item/permissions/requestApproval") throw new Error("无效的授权选择。");
      }
    }
    if (operation.type === "cancel" && !["codebuddy", "claude", "opencode"].includes(current.provider)) throw new Error("当前会话不支持取消提问。");
    if (operation.type === "answer" && (!operation.answers || typeof operation.answers !== "object" || Array.isArray(operation.answers))) throw new Error("无效的回答。");
    if (operation.type === "respond" && !["accept", "decline", "cancel"].includes(operation.action)) throw new Error("无效的处理选择。");
    submitting.add(notificationId); schedule();
    try {
      const args = operation.type === "approve" ? [operation.decision] : operation.type === "answer" ? [operation.answers]
        : operation.type === "respond" ? [operation.action, operation.content] : [];
      await graphicalService[method](sessionId, request.requestId, ...args);
      syncPending(sessionId);
    } finally { submitting.delete(notificationId); schedule(); }
  }
  function removeSession(id) {
    runs.delete(id);
    statuses.delete(id); seen.delete(id);
    const wasHead = queue[0]?.notification.sessionId === id;
    for (let index = queue.length - 1; index >= 0; index--) if (queue[index].notification.sessionId === id) queue.splice(index, 1);
    if (wasHead) { stopTimer(); ready = false; remaining = 15000; }
    changed(); schedule();
  }
  function handleDesktopEvent(channel, payload) {
    if (disposed) return;
    if (channel === "sessions:changed" && Array.isArray(payload)) {
      const ids = new Set(payload.map(session => session.id));
      for (const id of new Set([...runs.keys(), ...seen.keys()])) if (!ids.has(id)) removeSession(id);
      return;
    }
    if (channel === "codex-app-server:changed" && payload?.id) { syncPending(payload.id); return; }
    if (channel !== "agent:status" || !payload?.id) return;
    if (["cleared", "ended", "exited"].includes(payload.status)) { removeSession(payload.id); return; }
    const session = terminalManager.getSession(payload.id);
    if (session?.runtimeMode !== "app-server") return;
    if (statuses.get(payload.id)?.timestamp > payload.timestamp) return;
    statuses.set(payload.id, { ...payload });
    const graphical = syncPending(payload.id);
    let run = runs.get(payload.id);
    if (["running", "waiting_for_permission", "e_prompt"].includes(payload.status)) {
      if (payload.status === "e_prompt") return;
      if (!run || run.finished) {
        const baseline = source(payload.id);
        run = { baseline: new Map(baseline.messages.map(message => [message.id, message.text])), finished: false, timestamp: payload.timestamp };
        runs.set(payload.id, run);
      }
      return;
    }
    if (graphical?.pendingPlan && payload.status === "completed") {
      if (run) run.finished = true;
      return;
    }
    if (!["completed", "failed"].includes(payload.status) || !run) return;
    if (run.finished) {
      if (run.result?.status === payload.status) run.result = { ...run.result, ...payload };
      return;
    }
    if (Number.isFinite(payload.timestamp) && payload.timestamp < run.timestamp) return;
    run.finished = true;
    run.result = { ...payload };
    const completedSource = source(payload.id);
    const entry = { ready: false, notification: { id: String(++serial), sessionId: session.id, sessionTitle: cleanSummary(session.title) || payload.provider,
      status: payload.status, agentStatus: { ...payload }, summary: "", timestamp: payload.timestamp } };
    queue.push(entry);
    changed();
    // Let final-output events in the same completion burst settle before reading.
    run.settle = setTimeout(() => {
      settleTimers.delete(run.settle);
      run.settle = undefined;
      if (!queue.includes(entry)) return;
      const currentGraphical = syncPending(payload.id);
      if (!queue.includes(entry)) return;
      if (currentGraphical?.pendingPlan && payload.status === "completed") {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        changed(); schedule(); return;
      }
      entry.notification.agentStatus = { ...run.result };
      const current = runs.get(payload.id) === run ? source(payload.id) : completedSource;
      const messages = current.messages.filter(message => message.text?.trim() && run.baseline.get(message.id) !== message.text);
      const final = messages.filter(message => message.kind === "final" || message.kind === "reply" || message.type === "agentMessage" || message.type === "plan").at(-1);
      const primary = payload.status === "failed" ? cleanSummary(current.error?.message || current.error || run.result.message) : cleanSummary(final?.text);
      const known = primary || cleanSummary(run.result.activitySummary) || cleanSummary(messages.at(-1)?.text);
      entry.notification.summary = known || "暂无摘要";
      entry.ready = true; changed(); schedule();
    }, 200);
    settleTimers.add(run.settle);
  }
  function shutdown() {
    disposed = true;
    suspend();
    for (const timer of settleTimers) clearTimeout(timer);
    settleTimers.clear();
    runs.clear(); queue.length = 0;
  }
  return { snapshot, handleDesktopEvent, processAction, dismiss, setPresentation, suspend, shutdown };
}

module.exports = { createMascotNotifications, cleanSummary };
