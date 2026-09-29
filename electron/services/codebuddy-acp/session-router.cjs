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
  const codexRoute = method => (id, ...args) => {
    const session = terminalManager.getSession(id);
    if (!session || session.agentProvider !== "codex") throw new Error("仅 Codex 图形会话支持此操作。");
    return codex[method](id, ...args);
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
    readAccount: codexRoute("readAccount"), startLogin: codexRoute("startLogin"), cancelLogin: codexRoute("cancelLogin"),
    logout: codexRoute("logout"), refreshAccountUsage: codexRoute("refreshAccountUsage"),
    listHistory: route("listHistory"), readInitialUserInput: codexRoute("readInitialUserInput"), listCapabilities: route("listCapabilities"),
    loginMcpServer: codexRoute("loginMcpServer"), reloadMcpServers: codexRoute("reloadMcpServers"),
    listPlugins: codexRoute("listPlugins"), installPlugin: codexRoute("installPlugin"), uninstallPlugin: codexRoute("uninstallPlugin"),
    addPluginMarketplace: codexRoute("addPluginMarketplace"), refreshPluginMarketplace: codexRoute("refreshPluginMarketplace"), removePluginMarketplace: codexRoute("removePluginMarketplace"),
    resume: route("resume"), newThread: route("newThread"),
    renameThread: route("renameThread"), pinThread: routeCodex("pinThread"), forkThread: routeCodex("forkThread"),
    archiveThread: routeCodex("archiveThread"), unarchiveThread: routeCodex("unarchiveThread"),
    compactThread: codexRoute("compactThread"), getGoal: codexRoute("getGoal"), setGoal: codexRoute("setGoal"), clearGoal: codexRoute("clearGoal"),
    setMode: route("setMode"), setModel: route("setModel"), setEffort: route("setEffort"), setFastMode: codexRoute("setFastMode"),
    listModelMetadata(id) {
      if (serviceFor(id) !== codeBuddy) return [];
      return codeBuddy.listModelMetadata(id);
    },
    setContextWindow(id, value) {
      if (serviceFor(id) !== codeBuddy) throw new Error("只有 CodeBuddy 图形会话支持上下文窗口档位。");
      return codeBuddy.setContextWindow(id, value);
    },
    setMultitask(id, enabled) {
      if (serviceFor(id) !== codeBuddy) throw new Error("只有 CodeBuddy 图形会话支持 Multitask。");
      return codeBuddy.setMultitask(id, enabled);
    },
    sendTeamMessage(id, teamName, memberName, text) {
      if (serviceFor(id) !== codeBuddy) throw new Error("只有 CodeBuddy 图形会话支持团队消息。");
      return codeBuddy.sendTeamMessage(id, teamName, memberName, text);
    },
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
    close(id) { codex.close(id); codeBuddy.close(id); openCode?.close(id); claude?.close(id); qoder?.close(id); gemini?.close(id); grok?.close(id); },
    shutdown() { codex.shutdown(); codeBuddy.shutdown(); openCode?.shutdown(); claude?.shutdown(); qoder?.shutdown(); gemini?.shutdown(); grok?.shutdown(); }
  };
}

module.exports = { createGraphicalSessionRouter };
