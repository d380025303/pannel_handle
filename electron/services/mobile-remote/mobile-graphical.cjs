const MAX_TEXT_BYTES = 16 * 1024;

function toMobileGraphicalSnapshot(value) {
  const snapshot = value || {};
  return {
    threadId: snapshot.threadId ?? null,
    provider: snapshot.provider || "codex",
    busy: Boolean(snapshot.busy),
    archived: Boolean(snapshot.archived),
    error: snapshot.error || null,
    mode: snapshot.mode || "default",
    nativeMode: snapshot.nativeMode || null,
    capabilities: snapshot.capabilities || null,
    pendingPlan: snapshot.pendingPlan || null,
    items: (snapshot.items || []).map(item => ({
      id: item.id, type: item.type, turnId: item.turnId, text: item.text,
      command: item.command, output: item.output, status: item.status,
      toolName: item.toolName, toolKind: item.toolKind, explanation: item.explanation,
      plan: item.plan, questions: item.questions
    })),
    approvals: (snapshot.approvals || []).map(value => ({
      requestId: value.requestId, method: value.method,
      params: {
        itemId: value.params?.itemId, reason: value.params?.reason,
        command: value.params?.command, cwd: value.params?.cwd,
        changes: value.params?.changes, choices: value.params?.choices,
        networkApprovalContext: value.params?.networkApprovalContext
      }
    })),
    questions: (snapshot.questions || []).map(value => ({
      requestId: value.requestId, submitting: value.submitting,
      params: {
        threadId: value.params?.threadId, turnId: value.params?.turnId,
        questions: value.params?.questions
      }
    }))
  };
}

function createMobileGraphicalHandlers({ terminalManager, graphicalService, send }) {
  function assertSession(sessionId) {
    const session = terminalManager.getSession(sessionId);
    if (!session || session.runtimeMode !== "app-server" || !graphicalService)
      throw new Error("图形会话不存在或已经结束。");
    return session;
  }

  function sendSnapshot(socket, sessionId, snapshot) {
    if (socket.graphicalSessionId === sessionId)
      send(socket, { type: "graphical.snapshot", sessionId, snapshot: toMobileGraphicalSnapshot(snapshot) });
  }

  async function handle(socket, message) {
    const sessionId = String(message.sessionId || "");
    assertSession(sessionId);
    if (message.type === "graphical.subscribe") {
      socket.subscriptions.clear();
      socket.graphicalSessionId = sessionId;
      sendSnapshot(socket, sessionId, graphicalService.snapshot(sessionId));
      return;
    }
    if (socket.graphicalSessionId !== sessionId) throw new Error("请先打开此图形会话。");
    const current = graphicalService.snapshot(sessionId);
    if (message.threadId !== current.threadId) throw new Error("对话已切换，请刷新后重试。");
    if (message.type === "graphical.submit") {
      const text = typeof message.text === "string" ? message.text.trim() : "";
      if (!text || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) throw new Error("消息为空或过长。");
      await graphicalService.submit(sessionId, text);
    } else if (message.type === "graphical.interrupt") {
      await graphicalService.interrupt(sessionId);
    } else if (message.type === "graphical.new-thread") {
      sendSnapshot(socket, sessionId, await graphicalService.newThread(sessionId));
    } else if (message.type === "graphical.history") {
      if (current.capabilities?.history === false) throw new Error("当前图形会话不支持历史记录。");
      const cursor = message.cursor == null ? null : String(message.cursor);
      if (cursor && cursor.length > 512) throw new Error("历史记录游标无效。");
      const history = await graphicalService.listHistory(sessionId, cursor);
      send(socket, { type: "graphical.history", sessionId, threadId: current.threadId,
        requestId: message.requestId, history });
      return;
    } else if (message.type === "graphical.resume") {
      const threadId = String(message.targetThreadId || "");
      if (!threadId || threadId.length > 200) throw new Error("历史会话无效。");
      sendSnapshot(socket, sessionId, await graphicalService.resume(sessionId, threadId));
    } else if (message.type === "graphical.approval") {
      if (!current.approvals?.some(value => String(value.requestId) === String(message.approvalId)))
        throw new Error("确认请求已失效。");
      if (typeof message.decision !== "boolean" && typeof message.decision !== "string")
        throw new Error("无效的确认选择。");
      await graphicalService.resolveApproval(sessionId, message.approvalId, message.decision);
    } else if (message.type === "graphical.answer") {
      if (!current.questions?.some(value => String(value.requestId) === String(message.questionId)))
        throw new Error("问题请求已失效。");
      await graphicalService.answerQuestion(sessionId, message.questionId, message.answers);
    } else if (message.type === "graphical.plan") {
      if (!current.pendingPlan || current.pendingPlan.itemId !== message.itemId)
        throw new Error("计划确认已失效。");
      if (message.execute === true) await graphicalService.executePlan(sessionId, message.itemId);
      else if (message.execute === false) sendSnapshot(socket, sessionId, await graphicalService.dismissPlan(sessionId, message.itemId));
      else throw new Error("无效的计划选择。");
    } else {
      throw new Error("该移动端操作不被允许。");
    }
    send(socket, { type: "command.ok", requestId: message.requestId });
  }

  function handleChanged(socket, payload) {
    if (!socket?.authenticated || payload?.id !== socket.graphicalSessionId) return;
    try {
      assertSession(payload.id);
      const current = graphicalService.snapshot(payload.id);
      if (current.threadId === payload.snapshot?.threadId) sendSnapshot(socket, payload.id, current);
    } catch { /* The session ended while a change was queued. */ }
  }

  return { handle, handleChanged };
}

module.exports = { createMobileGraphicalHandlers, toMobileGraphicalSnapshot };
