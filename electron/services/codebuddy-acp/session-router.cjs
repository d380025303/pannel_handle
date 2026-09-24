function createGraphicalSessionRouter(codex, codeBuddy, terminalManager) {
  const serviceFor = id => {
    const session = terminalManager.getSession(id);
    if (!session) throw new Error("图形会话不存在。");
    return session.agentProvider === "codebuddy" ? codeBuddy : codex;
  };
  const route = method => (id, ...args) => serviceFor(id)[method](id, ...args);
  return {
    start: (session, runtime) => (session.agentProvider === "codebuddy" ? codeBuddy : codex).start(session, runtime),
    restart: route("restart"), snapshot: route("snapshot"), getWorkspaceCwd: route("getWorkspaceCwd"),
    allowFiles: route("allowFiles"), previewAttachment: route("previewAttachment"),
    allowPastedImage: route("allowPastedImage"), discardPastedImage: route("discardPastedImage"),
    listHistory: route("listHistory"), resume: route("resume"), newThread: route("newThread"),
    setMode: route("setMode"), setModel: route("setModel"), setFastMode: route("setFastMode"),
    setNativeMode: route("setNativeMode"),
    resetUsageBaselines: (...args) => codex.resetUsageBaselines?.(...args),
    setExecutionPermission: route("setExecutionPermission"),
    dismissPlan: route("dismissPlan"), executePlan: route("executePlan"), submit: route("submit"),
    interrupt: route("interrupt"), resolveApproval: route("resolveApproval"), answerQuestion: route("answerQuestion"),
    close(id) { codex.close(id); codeBuddy.close(id); },
    shutdown() { codex.shutdown(); codeBuddy.shutdown(); }
  };
}

module.exports = { createGraphicalSessionRouter };
