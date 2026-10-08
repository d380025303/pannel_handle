function createGraphicalSessionRouter(codex, codeBuddy, terminalManager, openCode, claude, qoder, gemini, grok) {
  const serviceForProvider = provider => {
    if (provider === "codebuddy") return codeBuddy;
    if (provider === "opencode" && openCode) return openCode;
    if (provider === "claude" && claude) return claude;
    if (provider === "qoder" && qoder) return qoder;
    if (provider === "gemini" && gemini) return gemini;
    if (provider === "grok" && grok) return grok;
    if (!provider || provider === "codex") return codex;
    throw new Error("不支持的图形会话 Agent。");
  };
  const serviceFor = id => {
    const session = terminalManager.getSession(id);
    if (!session) throw new Error("图形会话不存在。");
    return serviceForProvider(session.agentProvider);
  };
  const route = method => (id, ...args) => {
    const service = serviceFor(id);
    if (typeof service[method] !== "function") throw new Error("当前图形会话不支持此操作。");
    return service[method](id, ...args);
  };
  const authInput = method => (id, ...args) => {
    // Terminal input can arrive after the owning panel has closed or switched Agent.
    if (terminalManager.getSession(id)?.agentProvider === "opencode") return openCode?.[method]?.(id, ...args);
  };
  const codexRoute = method => (id, ...args) => {
    const session = terminalManager.getSession(id);
    if (!session || session.agentProvider !== "codex") throw new Error("仅 Codex 图形会话支持此操作。");
    return codex[method](id, ...args);
  };
  const routeCodeBuddy = method => (id, ...args) => {
    const session = terminalManager.getSession(id);
    if (!session || session.agentProvider !== "codebuddy") throw new Error("仅 CodeBuddy 图形会话支持此操作。");
    return codeBuddy[method](id, ...args);
  };
  const routeCodex = method => (id, ...args) => {
    const session = terminalManager.getSession(id);
    if (!session || (session.agentProvider && session.agentProvider !== "codex")) throw new Error("仅 Codex 图形会话支持此操作。");
    return codex[method](id, ...args);
  };
  return {
    start: (session, runtime) => serviceForProvider(session.agentProvider).start(session, runtime),
    restart: route("restart"), snapshot: route("snapshot"), getWorkspaceCwd: route("getWorkspaceCwd"),
    allowFiles: route("allowFiles"), previewAttachment: route("previewAttachment"),
    allowPastedImage: route("allowPastedImage"), discardPastedImage: route("discardPastedImage"),
    setSubAgentView: routeCodex("setSubAgentView"), refreshSubAgents: routeCodex("refreshSubAgents"),
    setupWindowsSandbox: routeCodex("setupWindowsSandbox"),
    readAccount: codexRoute("readAccount"), startLogin: codexRoute("startLogin"), cancelLogin: codexRoute("cancelLogin"),
    logout: codexRoute("logout"), refreshAccountUsage: codexRoute("refreshAccountUsage"),
    startAcpLogin: route("startAcpLogin"), cancelAcpLogin: authInput("cancelAcpLogin"),
    writeAcpLogin: authInput("writeAcpLogin"), resizeAcpLogin: authInput("resizeAcpLogin"),
    readConfiguration: routeCodex("readConfiguration"), setPermissionProfile: routeCodex("setPermissionProfile"),
    listHistory: route("listHistory"), readInitialUserInput: codexRoute("readInitialUserInput"), listCapabilities: route("listCapabilities"),
    readAppDetail: codexRoute("readAppDetail"), readPluginDetail: codexRoute("readPluginDetail"),
    setSkillEnabled: codexRoute("setSkillEnabled"),
    readPluginSkill: codexRoute("readPluginSkill"), readMcpResource: codexRoute("readMcpResource"),
    loginMcpServer: codexRoute("loginMcpServer"), reloadMcpServers: codexRoute("reloadMcpServers"),
    listPlugins: codexRoute("listPlugins"), installPlugin: codexRoute("installPlugin"), uninstallPlugin: codexRoute("uninstallPlugin"),
    addPluginMarketplace: codexRoute("addPluginMarketplace"), refreshPluginMarketplace: codexRoute("refreshPluginMarketplace"), removePluginMarketplace: codexRoute("removePluginMarketplace"),
    resume: route("resume"), newThread: route("newThread"),
    revertThread: route("revertThread"), restoreThread: route("restoreThread"),
    renameThread: route("renameThread"), pinThread: routeCodex("pinThread"),
    forkThread(id, threadId, ...args) {
      const service = serviceFor(id);
      if (service !== codex && service !== openCode) throw new Error("当前图形会话不支持分叉。");
      return service.forkThread(id, threadId, ...args);
    },
    deleteThread(id, threadId) {
      if (serviceFor(id) !== openCode) throw new Error("当前图形会话不支持删除历史。");
      return openCode.deleteThread(id, threadId);
    },
    archiveThread: routeCodex("archiveThread"), unarchiveThread: routeCodex("unarchiveThread"),
    startReview: codexRoute("startReview"),
    compactThread: codexRoute("compactThread"),
    listBackgroundTerminals: codexRoute("listBackgroundTerminals"), terminateBackgroundTerminal: codexRoute("terminateBackgroundTerminal"),
    cleanBackgroundTerminals: codexRoute("cleanBackgroundTerminals"),
    listScheduledTasks: routeCodeBuddy("listScheduledTasks"), createScheduledTask: routeCodeBuddy("createScheduledTask"),
    deleteScheduledTask: routeCodeBuddy("deleteScheduledTask"),
    askSideQuestion: routeCodeBuddy("askSideQuestion"), cancelSideQuestion: routeCodeBuddy("cancelSideQuestion"),
    listJobs: routeCodeBuddy("listJobs"), jobDispatchContext: routeCodeBuddy("jobDispatchContext"),
    listResumableJobs: routeCodeBuddy("listResumableJobs"), dispatchJob: routeCodeBuddy("dispatchJob"),
    resumeJob: routeCodeBuddy("resumeJob"), jobTranscript: routeCodeBuddy("jobTranscript"),
    jobAction: routeCodeBuddy("jobAction"), watchJob: routeCodeBuddy("watchJob"), unwatchJob: routeCodeBuddy("unwatchJob"),
    getGoal: route("getGoal"), setGoal: route("setGoal"), clearGoal: route("clearGoal"),
    refreshGoal(id) {
      if (serviceFor(id) !== codeBuddy) throw new Error("只有 CodeBuddy 图形会话支持目标状态刷新。");
      return codeBuddy.refreshGoal(id);
    },
    setMode: route("setMode"), setModel: route("setModel"), setEffort: route("setEffort"), setFastMode: codexRoute("setFastMode"),
    listModelMetadata(id) {
      if (serviceFor(id) !== codeBuddy) return [];
      return codeBuddy.listModelMetadata(id);
    },
    setContextWindow(id, value) {
      if (serviceFor(id) !== codeBuddy) throw new Error("只有 CodeBuddy 图形会话支持上下文窗口档位。");
      return codeBuddy.setContextWindow(id, value);
    },
    mcpRestart: routeCodeBuddy("mcpRestart"), mcpAppImages: routeCodeBuddy("mcpAppImages"),
    mcpRuntime: routeCodeBuddy("mcpRuntime"), mcpAppLoad: routeCodeBuddy("mcpAppLoad"),
    mcpAppRead: routeCodeBuddy("mcpAppRead"), mcpAppPrepare: routeCodeBuddy("mcpAppPrepare"),
    mcpAppResolve: routeCodeBuddy("mcpAppResolve"), mcpAppDispose: routeCodeBuddy("mcpAppDispose"),
    setMultitask(id, enabled) {
      if (serviceFor(id) !== codeBuddy) throw new Error("只有 CodeBuddy 图形会话支持 Multitask。");
      return codeBuddy.setMultitask(id, enabled);
    },
    sendTeamMessage(id, teamName, memberName, text) {
      if (serviceFor(id) !== codeBuddy) throw new Error("只有 CodeBuddy 图形会话支持团队消息。");
      return codeBuddy.sendTeamMessage(id, teamName, memberName, text);
    },
    listMainAgents: route("listMainAgents"), setMainAgent: route("setMainAgent"),
    setNativeMode: route("setNativeMode"),
    resetUsageBaselines: (...args) => codex.resetUsageBaselines?.(...args),
    setExecutionPermission: route("setExecutionPermission"),
    dismissPlan: route("dismissPlan"), executePlan: route("executePlan"), submit: route("submit"),
    interrupt: route("interrupt"), resolveApproval: route("resolveApproval"), answerQuestion: route("answerQuestion"),
    cancelQuestion(id, requestId) {
      const service = serviceFor(id);
      if (![codeBuddy, openCode, claude].includes(service)) throw new Error("当前图形会话不支持取消提问。");
      return service.cancelQuestion(id, requestId);
    },
    rewind(id, messageId, scope) {
      if (serviceFor(id) !== codeBuddy) throw new Error("只有 CodeBuddy 图形会话支持回退。");
      return codeBuddy.rewind(id, messageId, scope);
    },
    resolveElicitation: codexRoute("resolveElicitation"),
    close(id) { return Promise.allSettled([codex.close(id), codeBuddy.close(id), openCode?.close(id), claude?.close(id), qoder?.close(id), gemini?.close(id), grok?.close(id)]); },
    shutdown() { return Promise.allSettled([codex.shutdown(), codeBuddy.shutdown(), openCode?.shutdown(), claude?.shutdown(), qoder?.shutdown(), gemini?.shutdown(), grok?.shutdown()]); }
  };
}

module.exports = { createGraphicalSessionRouter };
