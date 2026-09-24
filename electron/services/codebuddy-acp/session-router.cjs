function createGraphicalSessionRouter(codex, codeBuddy, terminalManager, openCode) {
  const serviceForProvider = provider => provider === "codebuddy" ? codeBuddy : provider === "opencode" ? openCode : codex;
  const serviceFor = id => {
    const session = terminalManager.getSession(id);
    if (!session) throw new Error("图形会话不存在。");
    return serviceForProvider(session.agentProvider);
  };
  const route = method => (id, ...args) => serviceFor(id)[method](id, ...args);
  return {
    start: (session, runtime) => serviceForProvider(session.agentProvider).start(session, runtime),
    restart: route("restart"), snapshot: route("snapshot"), getWorkspaceCwd: route("getWorkspaceCwd"),
    allowFiles: route("allowFiles"), previewAttachment: route("previewAttachment"),
    allowPastedImage: route("allowPastedImage"), discardPastedImage: route("discardPastedImage"),
    listHistory: route("listHistory"), resume: route("resume"), newThread: route("newThread"),
    setMode: route("setMode"), setModel: route("setModel"), setEffort: route("setEffort"), setFastMode: route("setFastMode"),
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
