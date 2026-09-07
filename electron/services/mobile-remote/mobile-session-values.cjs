function toRuntimeSession(session) {
  return {
    id: session.id,
    templateId: session.templateId,
    title: session.title,
    type: session.type,
    cwd: session.cwd,
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
