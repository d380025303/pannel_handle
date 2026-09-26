const MAX_TEXT_BYTES = 16 * 1024;

function toMobileUsageSnapshot(value) {
  return {
    provider: value.provider,
    fetchedAt: value.fetchedAt,
    primaryLimitId: value.primaryLimitId,
    ...(value.summary?.kind === "credits" ? { summary: {
      kind: "credits", total: value.summary.total, used: value.summary.used,
      remaining: value.summary.remaining, usedPercent: value.summary.usedPercent,
      remainingPercent: value.summary.remainingPercent, unit: value.summary.unit
    } } : value.summary?.kind === "currency" ? { summary: {
      kind: "currency", currency: value.summary.currency, available: value.summary.available,
      cash: value.summary.cash, voucher: value.summary.voucher,
      credit: value.summary.credit, owed: value.summary.owed
    } } : {}),
    limits: (value.limits || []).map(limit => ({
      id: limit.id, name: limit.name, usedPercent: limit.usedPercent,
      remainingPercent: limit.remainingPercent, windowDurationMins: limit.windowDurationMins,
      resetsAt: limit.resetsAt, category: limit.category, totalAmount: limit.totalAmount,
      usedAmount: limit.usedAmount, remainingAmount: limit.remainingAmount,
      total: limit.total, used: limit.used, remaining: limit.remaining,
      unit: limit.unit, expiresAt: limit.expiresAt, available: limit.available,
      unlimited: limit.unlimited
    }))
  };
}

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
    nativeModes: (snapshot.nativeModes || []).map(mode => ({ id: mode.id, name: mode.name })),
    model: snapshot.model || null,
    backend: snapshot.backend || null,
    effectiveModel: snapshot.effectiveModel || null,
    models: (snapshot.models || []).map(model => ({ id: model.id, displayName: model.displayName })),
    effort: snapshot.effort || null,
    fastMode: Boolean(snapshot.fastMode),
    executionPermission: snapshot.executionPermission || null,
    acpOptions: (snapshot.acpOptions || []).filter(option => option.id === "model" || option.id === "effort")
      .map(option => ({ id: option.id, currentValue: option.currentValue,
        options: (option.options || []).map(value => ({ value: value.value, name: value.name })) })),
    capabilities: snapshot.capabilities || null,
    pendingPlan: snapshot.pendingPlan || null,
    items: (snapshot.items || []).map(item => ({
      id: item.id, type: item.type, turnId: item.turnId, text: item.text,
      command: item.command, output: item.output, status: item.status,
      toolName: item.toolName, toolKind: item.toolKind, explanation: item.explanation,
      tool: item.tool, server: item.server, query: item.query,
      arguments: item.arguments, result: item.result, changes: item.changes, locations: item.locations,
      plan: item.plan, questions: item.questions,
      attachments: (item.attachments || []).map(file => ({ name: file.name || "附件" }))
    })),
    diagnostics: snapshot.provider === "codex" ? (snapshot.diagnostics || [])
      .filter(event => event.kind === "error")
      .map(event => ({ id: event.id, turnId: event.turnId, at: event.at,
        message: String(event.payload?.message || "Codex 运行失败。"),
        kind: event.payload?.kind || null, httpStatusCode: event.payload?.httpStatusCode ?? null,
        additionalDetails: event.payload?.additionalDetails ?? null })) : [],
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

function createMobileGraphicalHandlers({ terminalManager, graphicalService, getAgentUsage, uploads, send }) {
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

  function assertSwitchAllowed(socket, message) {
    const sessionId = String(message.sessionId || "");
    const session = assertSession(sessionId);
    if (socket.graphicalSessionId !== sessionId) throw new Error("请先打开此图形会话。");
    const current = graphicalService.snapshot(sessionId);
    if (message.threadId !== current.threadId) throw new Error("对话已切换，请刷新后重试。");
    if (!["codex", "codebuddy", "opencode"].includes(session.agentProvider))
      throw new Error("当前会话不支持切换图形 Agent。");
    if (!["codex", "codebuddy", "opencode"].includes(message.provider) || message.provider === session.agentProvider)
      throw new Error("无效的目标 Agent。");
    if (current.busy || current.approvals?.length || current.questions?.length || current.pendingPlan)
      throw new Error("当前会话正在执行或有待处理操作，请处理后再切换 Agent。");
    return sessionId;
  }

  async function handle(socket, message) {
    const sessionId = String(message.sessionId || "");
    const session = assertSession(sessionId);
    if (message.type === "graphical.subscribe") {
      socket.subscriptions.clear();
      socket.graphicalSessionId = sessionId;
      sendSnapshot(socket, sessionId, graphicalService.snapshot(sessionId));
      return;
    }
    if (socket.graphicalSessionId !== sessionId) throw new Error("请先打开此图形会话。");
    const current = graphicalService.snapshot(sessionId);
    if (message.type === "graphical.usage") {
      if (!["codex", "codebuddy"].includes(session.agentProvider)) throw new Error("当前 Agent 不提供额度查询。");
      if (message.threadId !== current.threadId) throw new Error("对话已切换，请刷新后重试。");
      if (!getAgentUsage) throw new Error("额度服务不可用。");
      const usage = await getAgentUsage(sessionId, { force: message.force === true });
      if (socket.graphicalSessionId === sessionId && graphicalService.snapshot(sessionId).threadId === message.threadId)
        send(socket, { type: "graphical.usage", sessionId, threadId: message.threadId,
          requestId: message.requestId, usage: toMobileUsageSnapshot(usage) });
      return;
    }
    if (message.type === "graphical.upload.discard") {
      uploads?.discard(socket, Array.isArray(message.fileIds) ? message.fileIds : []);
      send(socket, { type: "command.ok", requestId: message.requestId });
      return;
    }
    if (message.threadId !== current.threadId) throw new Error("对话已切换，请刷新后重试。");
    if (message.type === "graphical.upload.prepare") {
      if (!uploads || !current.threadId || current.archived || current.busy && current.provider !== "codex")
        throw new Error("当前会话不可上传附件。");
      const upload = uploads.prepare(socket, sessionId, current.threadId, message.name, message.size);
      send(socket, { type: "graphical.upload.ready", requestId: message.requestId, ...upload });
      return;
    } else if (message.type === "graphical.model") {
      if (!current.threadId || current.busy || current.archived) throw new Error("当前会话不可切换模型。");
      const modelId = message.modelId;
      const options = current.provider === "codex" && current.backend === "openai"
        ? (current.models || []).map(model => model.id)
        : current.provider !== "codex" ? (current.acpOptions || []).find(option => option.id === "model")?.options?.map(option => option.value) || [] : [];
      if (typeof modelId !== "string" || !options.includes(modelId)) throw new Error("请选择当前会话可用的模型。");
      await graphicalService.setModel(sessionId, modelId);
      sendSnapshot(socket, sessionId, graphicalService.snapshot(sessionId));
    } else if (message.type === "graphical.submit") {
      const text = typeof message.text === "string" ? message.text.trim() : "";
      const fileIds = message.fileIds === undefined ? [] : message.fileIds;
      const filePaths = uploads ? uploads.paths(socket, sessionId, current.threadId, fileIds) : [];
      if ((!text && !filePaths.length) || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES)
        throw new Error("消息为空或过长。");
      if (filePaths.length) graphicalService.allowFiles(sessionId, filePaths);
      await graphicalService.submit(sessionId, text, filePaths);
      uploads?.consume(fileIds);
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
    } else if (message.type === "graphical.mode") {
      if (current.busy || current.archived) throw new Error("当前会话不可切换模式。");
      if (message.mode !== "plan" && message.mode !== "default") throw new Error("无效的图形会话模式。");
      if (message.mode === "plan" && current.capabilities?.plan === false) throw new Error("当前图形会话不支持 Plan 模式。");
      const provider = current.provider || "codex";
      if (provider === "codex") {
        await graphicalService.setMode(sessionId, message.mode);
      } else {
        const modes = current.nativeModes || [];
        const choices = message.mode === "plan" ? ["plan"] : ["default", "normal", "code", "ask", "build", "acceptEdits"];
        const native = message.mode === "plan" ? modes.find(value => /plan/i.test(value.id))
          : choices.map(id => modes.find(value => value.id.toLowerCase() === id.toLowerCase())).find(Boolean);
        if (!native) throw new Error(`当前图形会话不支持 ${message.mode === "plan" ? "Plan" : "Exec"} 模式。`);
        await graphicalService.setNativeMode(sessionId, native.id);
      }
      sendSnapshot(socket, sessionId, graphicalService.snapshot(sessionId));
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

  return { handle, handleChanged, assertSwitchAllowed };
}

module.exports = { createMobileGraphicalHandlers, toMobileGraphicalSnapshot, toMobileUsageSnapshot };
