function toRuntimeSession(session) {
  return {
    id: session.id,
    templateId: session.templateId,
    title: session.title,
    type: session.type,
    runtimeMode: session.runtimeMode === "app-server" ? "app-server" : "terminal",
    agentProvider: session.agentProvider,
    cwd: session.cwd,
    quickCommands: Array.isArray(session.quickCommands) ? session.quickCommands.map(({ id, command, mode, pinned }) => ({ id, command, mode: mode || "write", pinned: pinned === true })) : [],
    tags: Array.isArray(session.tags) ? session.tags : []
  };
}

function toSavedTemplates(sessionStore, terminalManager) {
  const counts = new Map();
  for (const session of terminalManager.listSessions()) {
    if (session.templateId) counts.set(session.templateId, (counts.get(session.templateId) || 0) + 1);
  }
  return sessionStore.getLibrary().map((template) => ({
    id: template.id,
    title: template.title,
    type: template.type,
    runtimeMode: ["codex", "codebuddy", "opencode", "claude", "qoder", "gemini", "grok"].includes(template.agentProvider) && template.graphicalSessionEnabled !== false ? "app-server" : "terminal",
    agentProvider: template.agentProvider,
    cwd: template.cwd,
    wslDistro: template.wslDistro,
    sshEndpoint: template.type === "ssh" && template.sshConfig?.host
      ? `${template.sshConfig.username ? `${template.sshConfig.username}@` : ""}${template.sshConfig.host}:${template.sshConfig.port || 22}`
      : undefined,
    tags: Array.isArray(template.tags) ? template.tags : [],
    runningCount: counts.get(template.id) || 0
  }));
}

function launchMobileTemplate(agentSessionLauncher, template, cols, rows) {
  return agentSessionLauncher.launchSession(template, { cols, rows, recordUsage: true });
}

module.exports = { toRuntimeSession, toSavedTemplates, launchMobileTemplate };
