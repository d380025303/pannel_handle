function createGraphicalSessionRouter(codex, codeBuddy, terminalManager, openCode) {
  const serviceForProvider = provider => provider === "codebuddy" ? codeBuddy : provider === "opencode" ? openCode : codex;
  const serviceFor = id => {
    const session = terminalManager.getSession(id);
    if (!session) throw new Error("图形会话不存在。");
    return serviceForProvider(session.agentProvider);
  };
  const route = method => (id, ...args) => serviceFor(id)[method](id, ...args);
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
    listHistory: route("listHistory"), listCapabilities: route("listCapabilities"), resume: route("resume"), newThread: route("newThread"),
    renameThread: routeCodex("renameThread"), pinThread: routeCodex("pinThread"), forkThread: routeCodex("forkThread"),
    archiveThread: routeCodex("archiveThread"), unarchiveThread: routeCodex("unarchiveThread"),
    compactThread: codexRoute("compactThread"), getGoal: codexRoute("getGoal"), setGoal: codexRoute("setGoal"), clearGoal: codexRoute("clearGoal"),
    setMode: route("setMode"), setModel: route("setModel"), setEffort: route("setEffort"), setFastMode: route("setFastMode"),
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
    close(id) { codex.close(id); codeBuddy.close(id); openCode?.close(id); },
    shutdown() { codex.shutdown(); codeBuddy.shutdown(); openCode?.shutdown(); }
  };
}

module.exports = { createGraphicalSessionRouter };
