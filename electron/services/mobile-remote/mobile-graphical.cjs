const { createMobileOpenCodeHandlers } = require("./mobile-opencode.cjs");
const { createMobileCodeBuddyHandlers } = require("./mobile-codebuddy.cjs");
const { createMobileCodexHandlers } = require("./mobile-codex.cjs");
const { toMobileGraphicalSnapshot, toMobileUsageSnapshot } = require("./mobile-graphical-snapshot.cjs");
const { availableModelIds, visibleOpenCodeOptions, nativeModeFor } = require("./graphical-command-policy.cjs");

const { graphicalSubmitError, validateGraphicalSubmitText } = require("./graphical-input-policy.cjs");

function createMobileGraphicalHandlers({ terminalManager, graphicalService, getAgentUsage, getOpenCodeVerifiedModels, getCodexVerifiedModels, getCodeBuddyVerifiedModels, codeBuddyPluginService, codeBuddyVersionService, openCodeVersionService, uploads, send, codexPluginService, codexVersionService, projectSearchService, agentSessionLauncher, mcpConfigService }) {
  const openCode = createMobileOpenCodeHandlers({ graphicalService, openCodeVersionService, agentSessionLauncher });
  const codex = createMobileCodexHandlers({ graphicalService, codexPluginService, codexVersionService, projectSearchService, agentSessionLauncher, mcpConfigService, getCodexVerifiedModels });
  const buddy = createMobileCodeBuddyHandlers({ graphicalService, codeBuddyPluginService, codeBuddyVersionService, openCodeVersionService, mcpConfigService, agentSessionLauncher, getCodeBuddyVerifiedModels });
  function assertSession(sessionId) {
    const session = terminalManager.getSession(sessionId);
    if (!session || session.runtimeMode !== "app-server" || !graphicalService)
      throw new Error("图形会话不存在或已经结束。");
    return session;
  }

  function sendSnapshot(socket, sessionId, snapshot) {
    if (socket.graphicalSessionId === sessionId) {
      const session = terminalManager.getSession(sessionId);
      const models = snapshot.provider === "opencode"
        ? visibleOpenCodeOptions(snapshot, session, session?.type === "ssh" ? undefined : getOpenCodeVerifiedModels?.()) : undefined;
      send(socket, { type: "graphical.snapshot", sessionId, snapshot: toMobileGraphicalSnapshot(snapshot, models, session) });
      socket.graphicalStreamId = snapshot.streamId || null;
      socket.graphicalRevision = snapshot.revision ?? null;
    }
  }

  function assertSwitchAllowed(socket, message) {
    const sessionId = String(message.sessionId || "");
    const session = assertSession(sessionId);
    if (socket.graphicalSessionId !== sessionId) throw new Error("请先打开此图形会话。");
    const current = graphicalService.snapshot(sessionId);
    if (message.threadId !== current.threadId) throw new Error("对话已切换，请刷新后重试。");
    if (!["codex", "codebuddy", "opencode", "claude", "qoder", "gemini", "grok"].includes(session.agentProvider))
      throw new Error("当前会话不支持切换图形 Agent。");
    if (!["codex", "codebuddy", "opencode", "claude", "qoder", "gemini", "grok"].includes(message.provider) || message.provider === session.agentProvider
      || (message.provider === "gemini" || message.provider === "grok") && session.type === "ssh")
      throw new Error("无效的目标 Agent。");
    if (current.busy || current.approvals?.length || current.questions?.length || current.pendingPlan || ["running", "reconnecting"].includes(current.acpAuth?.status))
      throw new Error("当前会话正在执行或有待处理操作，请处理后再切换 Agent。");
    return sessionId;
  }

  async function handle(socket, message) {
    const sessionId = String(message.sessionId || "");
    const session = assertSession(sessionId);
    if (message.type === "graphical.subscribe") {
      if (socket.graphicalSessionId !== sessionId) openCode.release(socket);
      socket.subscriptions.clear();
      socket.graphicalSessionId = sessionId;
      socket.graphicalDelta = message.delta === true;
      sendSnapshot(socket, sessionId, graphicalService.snapshot(sessionId));
      return;
    }
    if (socket.graphicalSessionId !== sessionId) throw new Error("请先打开此图形会话。");
    const current = graphicalService.snapshot(sessionId);
    if (message.type === "graphical.usage") {
      if (!["codex", "codebuddy", "qoder", "gemini"].includes(session.agentProvider) || (session.agentProvider === "qoder" || session.agentProvider === "gemini") && !["windows", "wsl"].includes(session.type)) throw new Error("当前 Agent 不提供额度查询。");
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
    if (message.type.startsWith("graphical.codex.") || message.type.startsWith("graphical.codebuddy.") || message.type.startsWith("graphical.opencode.")) {
      let result = await (message.type.startsWith("graphical.opencode.") ? openCode : message.type.startsWith("graphical.codebuddy.") ? buddy : codex).handle(message, session, current, socket);
      if (result && Array.isArray(result.items) && Object.hasOwn(result, "threadId")) result = toMobileGraphicalSnapshot(result, result.provider === "opencode" ? visibleOpenCodeOptions(result, session, session.type === "ssh" ? undefined : getOpenCodeVerifiedModels?.()) : undefined, session);
      send(socket, { type: "graphical.result", requestId: message.requestId, sessionId, threadId: message.threadId, result: result ?? null });
      if (socket.graphicalSessionId === sessionId && terminalManager.getSession(sessionId)) {
        sendSnapshot(socket, sessionId, graphicalService.snapshot(sessionId));
      }
      if (["graphical.codex.model-source", "graphical.codebuddy.model-source", "graphical.opencode.reconnect"].includes(message.type) && result?.id) send(socket, { type: "session.launched", sessionId: result.id });
      return;
    }
    if (current.provider === "opencode" && ["graphical.model", "graphical.mode", "graphical.native-mode", "graphical.new-thread", "graphical.resume", "graphical.fork", "graphical.delete", "graphical.upload.prepare"].includes(message.type)
      && (current.pendingPlan || current.approvals?.length || current.questions?.length || ["running", "reconnecting"].includes(current.acpAuth?.status))) throw new Error("当前会话有待处理操作。请处理后重试。");
    if (message.type === "graphical.upload.prepare") {
      if (!uploads || !current.threadId || current.archived || current.busy && current.provider !== "codex")
        throw new Error("当前会话不可上传附件。");
      const upload = uploads.prepare(socket, sessionId, current.threadId, message.name, message.size);
      send(socket, { type: "graphical.upload.ready", requestId: message.requestId, ...upload });
      return;
    } else if (message.type === "graphical.effort") {
      if (!["codex", "opencode"].includes(session.agentProvider) || session.agentProvider !== (current.provider || "codex")) throw new Error("当前 Agent 不支持此思考强度操作。");
      if (!current.threadId || current.busy || current.archived || current.pendingPlan
        || current.approvals?.length || current.questions?.length) throw new Error("当前会话不可切换思考强度。");
      const option = current.provider === "opencode" ? current.acpOptions?.find(value => value.id === "effort" && value.type === "select")
        : current.backend === "openai" ? { options: current.models?.find(model => model.id === (current.model || current.effectiveModel))?.supportedReasoningEfforts?.map(value => ({ value: value.reasoningEffort })), currentValue: current.effort } : null;
      if (typeof message.effort !== "string" || !option?.options?.some(value => value.value === message.effort))
        throw new Error("请选择当前会话可用的思考强度。");
      if (message.effort !== option.currentValue) await graphicalService.setEffort(sessionId, message.effort);
      sendSnapshot(socket, sessionId, graphicalService.snapshot(sessionId));
    } else if (message.type === "graphical.model") {
      if (!current.threadId || current.busy || current.archived) throw new Error("当前会话不可切换模型。");
      const modelId = message.modelId;
      const options = availableModelIds(current, session,
        current.provider === "opencode" && session.type !== "ssh" ? getOpenCodeVerifiedModels?.() : undefined);
      if (typeof modelId !== "string" || !options.includes(modelId)) throw new Error("请选择当前会话可用的模型。");
      await graphicalService.setModel(sessionId, modelId);
      sendSnapshot(socket, sessionId, graphicalService.snapshot(sessionId));
    } else if (message.type === "graphical.submit") {
      const blocked = graphicalSubmitError(current);
      if (blocked) throw new Error(blocked);
      const fileIds = message.fileIds === undefined ? [] : message.fileIds;
      const filePaths = uploads ? uploads.paths(socket, sessionId, current.threadId, fileIds) : [];
      const text = validateGraphicalSubmitText(message.text, filePaths.length > 0);
      if (filePaths.length) graphicalService.allowFiles(sessionId, filePaths);
      const references = message.references || [];
      if (!Array.isArray(references) || references.length > 50 || references.some(value => !value || !["skill", "app"].includes(value.kind)
        || typeof value.name !== "string" || typeof value.path !== "string" || value.path.length > 4000 || typeof value.token !== "string")) throw new Error("能力引用无效。");
      if (references.length) await graphicalService.submit(sessionId, text, filePaths, references);
      else await graphicalService.submit(sessionId, text, filePaths);
      uploads?.consume(fileIds);
    } else if (message.type === "graphical.interrupt") {
      await graphicalService.interrupt(sessionId);
    } else if (message.type === "graphical.new-thread") {
      sendSnapshot(socket, sessionId, await graphicalService.newThread(sessionId));
    } else if (message.type === "graphical.history") {
      if (current.capabilities?.history === false) throw new Error("当前图形会话不支持历史记录。");
      const cursor = message.cursor == null ? null : String(message.cursor);
      if (cursor && cursor.length > 512) throw new Error("历史记录游标无效。");
      if (message.archived !== undefined && typeof message.archived !== "boolean") throw new Error("历史筛选无效。");
      const history = current.provider === "codex" && !cursor && !message.archived
        ? await Promise.all([graphicalService.listHistory(sessionId, null, false, true), graphicalService.listHistory(sessionId, null, false, false)])
          .then(([pinned, normal]) => ({ data: [...pinned.data, ...normal.data], nextCursor: normal.nextCursor }))
        : await graphicalService.listHistory(sessionId, cursor, message.archived === true, current.provider === "codex" && !message.archived ? false : undefined);
      send(socket, { type: "graphical.history", sessionId, threadId: current.threadId,
        requestId: message.requestId, history });
      return;
    } else if (message.type === "graphical.fork" || message.type === "graphical.delete") {
      const fork = message.type === "graphical.fork";
      if (current.provider !== "opencode" || !current.capabilities?.[fork ? "forkHistory" : "deleteHistory"])
        throw new Error("当前图形会话不支持此历史操作。");
      if (current.busy || current.pendingPlan || current.approvals?.length || current.questions?.length)
        throw new Error("当前会话正在执行或有待处理操作。");
      const threadId = message.targetThreadId;
      if (typeof threadId !== "string" || !threadId || threadId.length > 200) throw new Error("历史会话无效。");
      let resultThreadId = current.threadId;
      if (fork) {
        const result = await graphicalService.forkThread(sessionId, threadId);
        resultThreadId = result.threadId;
        if (graphicalService.snapshot(sessionId).threadId === resultThreadId) sendSnapshot(socket, sessionId, result);
      } else await graphicalService.deleteThread(sessionId, threadId);
      send(socket, { type: "command.ok", requestId: message.requestId, sessionId, threadId: resultThreadId });
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
    } else if (message.type === "graphical.cancelQuestion") {
      if (!["codebuddy", "claude", "opencode"].includes(current.provider) || !current.questions?.some(value => String(value.requestId) === String(message.questionId)))
        throw new Error("问题请求已失效。");
      await graphicalService.cancelQuestion(sessionId, message.questionId);
    } else if (message.type === "graphical.mode") {
      if (current.busy || current.archived || current.pendingPlan) throw new Error("当前会话不可切换模式。");
      if (message.mode !== "plan" && message.mode !== "default") throw new Error("无效的图形会话模式。");
      if (message.mode === "plan" && current.capabilities?.plan === false) throw new Error("当前图形会话不支持 Plan 模式。");
      const provider = current.provider || "codex";
      if (provider === "codex") {
        await graphicalService.setMode(sessionId, message.mode);
      } else {
        const native = nativeModeFor(current, message.mode);
        if (!native) throw new Error(`当前图形会话不支持 ${message.mode === "plan" ? "Plan" : "Exec"} 模式。`);
        await graphicalService.setNativeMode(sessionId, native.id);
      }
      sendSnapshot(socket, sessionId, graphicalService.snapshot(sessionId));
    } else if (message.type === "graphical.permission") {
      if (current.provider !== "codex" || !current.threadId || current.busy)
        throw new Error("当前会话不可切换执行权限。");
      const allowed = ["readOnly", "askApproval", "fullAccess"];
      if (!allowed.includes(message.permission)
        || current.capabilities?.supportedPermissions && !current.capabilities.supportedPermissions.includes(message.permission))
        throw new Error("当前会话不支持此执行权限。");
      await graphicalService.setExecutionPermission(sessionId, message.permission);
      sendSnapshot(socket, sessionId, graphicalService.snapshot(sessionId));
    } else if (message.type === "graphical.native-mode") {
      if (!["codebuddy", "opencode", "claude", "qoder", "gemini", "grok"].includes(current.provider) || !current.threadId || current.busy || current.archived || current.pendingPlan)
        throw new Error("当前会话不可切换原生模式。");
      if (typeof message.modeId !== "string" || !current.nativeModes?.some(mode => mode.id === message.modeId))
        throw new Error("请选择当前会话可用的模式。");
      await graphicalService.setNativeMode(sessionId, message.modeId);
      sendSnapshot(socket, sessionId, graphicalService.snapshot(sessionId));
    } else if (message.type === "graphical.plan") {
      if (current.provider === "opencode" && message.execute === true && typeof message.itemId === "string") {
        await graphicalService.executePlan(sessionId, message.itemId);
        return send(socket, { type: "command.ok", requestId: message.requestId });
      }
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

  function handleDelta(socket, payload) {
    if (!socket?.authenticated || payload?.id !== socket.graphicalSessionId) return;
    try {
      assertSession(payload.id);
      if (socket.graphicalDelta && socket.graphicalStreamId === payload.streamId
        && socket.graphicalRevision === payload.baseRevision) {
        send(socket, { type: "graphical.delta", sessionId: payload.id, streamId: payload.streamId,
          threadId: payload.threadId, baseRevision: payload.baseRevision, revision: payload.revision,
          items: toMobileGraphicalSnapshot({ items: payload.items }).items, turnDiffs: toMobileGraphicalSnapshot({ turnDiffs: payload.turnDiffs }).turnDiffs, textDeltas: payload.textDeltas, subAgentTextDeltas: payload.subAgentTextDeltas });
        socket.graphicalRevision = payload.revision;
      } else sendSnapshot(socket, payload.id, graphicalService.snapshot(payload.id));
    } catch { /* The session ended while a change was queued. */ }
  }

  return { handle, handleChanged, handleDelta, assertSwitchAllowed, release: openCode.release,
    handleAuthEvent: (socket, channel, payload) => openCode.event(socket, channel, payload, send) };
}

module.exports = { createMobileGraphicalHandlers, toMobileGraphicalSnapshot, toMobileUsageSnapshot };
