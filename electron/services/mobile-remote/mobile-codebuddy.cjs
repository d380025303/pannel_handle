// Mobile CodeBuddy commands are explicit: client input never selects a service method.
function createMobileCodeBuddyHandlers({ graphicalService: service, codeBuddyPluginService: plugins,
  codeBuddyVersionService: version, mcpConfigService: mcp, agentSessionLauncher: launcher, getCodeBuddyVerifiedModels }) {
  const text = (value, limit = 4000) => {
    if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) throw new Error("参数无效。");
    return value;
  };
  const bool = value => { if (typeof value !== "boolean") throw new Error("参数无效。"); return value; };
  async function handle(message, session, current) {
    if (session.agentProvider !== "codebuddy" || current.provider !== "codebuddy") throw new Error("仅 CodeBuddy 图形会话支持此操作。");
    const command = message.type.slice("graphical.codebuddy.".length), p = message.input || {}, id = session.id;
    const windows = () => { if (session.type !== "windows") throw new Error("仅 Windows 本机会话支持此操作。"); };
    const idle = () => { if (!current.threadId || current.busy || current.archived || current.pendingPlan || current.approvals?.length || current.questions?.length) throw new Error("当前会话不可执行此操作。"); };
    const scope = () => { if (!["user", "project", "local"].includes(p.scope)) throw new Error("配置范围无效。"); return p.scope; };
    const target = () => { windows(); return { provider: "codebuddy", scope: scope(), sessionId: id, projectPath: service.getWorkspaceCwd(id) }; };
    switch (command) {
      case "attachment-preview": return service.previewAttachment(id, text(p.path));
      case "version": return version.check(id, p.force === true);
      case "version-update": idle(); return version.update(id);
      case "models": return session.type === "ssh" ? [] : getCodeBuddyVerifiedModels?.() || [];
      case "model-metadata": return service.listModelMetadata(id);
      case "model-source": idle(); {
        if (session.type === "ssh") throw new Error("SSH 会话不支持服务模型切换。");
        if (p.source !== "native" && !(getCodeBuddyVerifiedModels?.() || []).some(model => model.source === p.source && model.id === p.modelId)) throw new Error("请选择已通过 CodeBuddy 验证的模型。");
        if (p.source === "native" && p.modelId && !current.acpOptions?.find(option => option.id === "model")?.options?.some(option => option.value === p.modelId)) throw new Error("模型无效。");
        const next = await launcher.switchModelSource(id, p.source, true, p.modelId || undefined); return { id: next.id };
      }
      case "main-agents": return service.listMainAgents(id);
      case "main-agent": idle(); return service.setMainAgent(id, text(p.name, 512));
      case "multitask": idle(); return service.setMultitask(id, bool(p.enabled));
      case "context-window": idle(); if (!current.acpOptions?.find(option => option.id === "context_window")?.options?.some(option => option.value === p.value)) throw new Error("上下文档位无效。"); return service.setContextWindow(id, p.value);
      case "effort": idle(); if (!current.acpOptions?.find(option => ["effort", "reasoning_effort"].includes(option.id))?.options?.some(option => option.value === p.value)) throw new Error("思考强度无效。"); return service.setEffort(id, p.value);
      case "side-question": windows(); if (!current.capabilities?.sideQuestion) throw new Error("当前会话不支持旁问。"); return service.askSideQuestion(id, text(p.question, 8000));
      case "side-cancel": if (p.requestId !== current.sideQuestion?.requestId) throw new Error("旁问已失效。"); return service.cancelSideQuestion(id, text(p.requestId, 512));
      case "team-message": windows(); return service.sendTeamMessage(id, text(p.team, 512), text(p.member, 512), text(p.text, 16000));
      case "goal.read": return service.getGoal(id);
      case "goal.refresh": if (current.busy) throw new Error("请等待当前任务结束。"); return service.refreshGoal(id);
      case "goal.set": return service.setGoal(id, { objective: text(p.objective), status: "active" });
      case "goal.clear": return service.clearGoal(id);
      case "history.rename": idle(); return service.renameThread(id, text(p.targetThreadId, 200), text(p.name, 512));
      case "rewind": windows(); idle(); if (!current.capabilities?.rewind || !["Conversation", "Code", "CodeAndConversation"].includes(p.scope) || !current.items?.some(item => item.type === "userMessage" && item.rewindMessageId === p.messageId)) throw new Error("回退目标无效。"); return service.rewind(id, text(p.messageId, 200), p.scope);
      case "tasks": windows(); return service.listScheduledTasks(id, current.threadId);
      case "task-create": windows(); return service.createScheduledTask(id, current.threadId, { cron: text(p.cron, 512), prompt: text(p.prompt, 16000), recurring: bool(p.recurring), durable: bool(p.durable) });
      case "task-delete": windows(); return service.deleteScheduledTask(id, current.threadId, text(p.taskId, 512));
      case "jobs": windows(); return service.listJobs(id);
      case "job-context": windows(); return service.jobDispatchContext(id);
      case "job-history": windows(); return service.listResumableJobs(id);
      case "job-dispatch": windows(); text(p.prompt, 16000); return service.dispatchJob(id, p);
      case "job-resume": windows(); return service.resumeJob(id, text(p.sessionId, 512));
      case "job-transcript": windows(); return service.jobTranscript(id, text(p.jobId, 512));
      case "job-action": windows(); if (!["reply", "stop", "respawn", "rename", "delete"].includes(p.action)) throw new Error("后台操作无效。"); return service.jobAction(id, text(p.jobId, 512), p.action, p.input);
      case "plugins": windows(); return plugins.list(id);
      case "plugin-reload": windows(); return plugins.reload(id);
      case "plugin-install": windows(); return plugins.install(id, text(p.name, 512), text(p.marketplace, 512), scope());
      case "plugin-uninstall": windows(); return plugins.uninstall(id, text(p.name, 512), text(p.marketplace, 512), scope());
      case "plugin-enable": windows(); return plugins.enable(id, text(p.name, 512), text(p.marketplace, 512), scope());
      case "plugin-disable": windows(); return plugins.disable(id, text(p.name, 512), text(p.marketplace, 512), scope());
      case "plugin-update": windows(); return plugins.update(id, text(p.name, 512), text(p.marketplace, 512), scope());
      case "marketplace-add": windows(); return plugins.addMarketplace(id, text(p.source), text(p.name, 512), bool(p.autoUpdate));
      case "marketplace-refresh": windows(); return plugins.refreshMarketplace(id, text(p.name, 512));
      case "marketplace-remove": windows(); return plugins.removeMarketplace(id, text(p.name, 512));
      case "marketplace-auto": windows(); return plugins.setAutoUpdate(id, text(p.name, 512), bool(p.enabled));
      case "mcp-config": return mcp.list(target());
      case "mcp-save": return mcp.save({ ...target(), draft: p.draft, expectedVersion: text(p.expectedVersion, 512), originalName: p.originalName });
      case "mcp-remove": return mcp.remove({ ...target(), name: text(p.name, 512), expectedVersion: text(p.expectedVersion, 512) });
      case "mcp-reveal": if (!["url", "args", "env", "headers"].includes(p.field)) throw new Error("字段无效。"); return mcp.reveal({ ...target(), name: text(p.name, 512), field: p.field, key: p.key, expectedVersion: text(p.expectedVersion, 512) });
      case "mcp-runtime": windows(); return service.mcpRuntime(id);
      case "mcp-restart": windows(); idle(); return service.mcpRestart(id);
      case "app-load": windows(); return service.mcpAppLoad(id, current.threadId, text(p.itemId, 512));
      case "app-read": windows(); return service.mcpAppRead(id, current.threadId, text(p.itemId, 512), text(p.uri));
      case "app-prepare": windows(); return service.mcpAppPrepare(id, current.threadId, text(p.itemId, 512), text(p.name, 512), p.args || {});
      case "app-resolve": windows(); return service.mcpAppResolve(id, text(p.token, 512), bool(p.approved));
      case "app-dispose": windows(); return service.mcpAppDispose(id, current.threadId, text(p.itemId, 512));
      case "app-images": windows(); return service.mcpAppImages(id, current.threadId, text(p.itemId, 512), p.images);
      default: throw new Error("该移动端操作不被允许。");
    }
  }
  return { handle };
}
module.exports = { createMobileCodeBuddyHandlers };
