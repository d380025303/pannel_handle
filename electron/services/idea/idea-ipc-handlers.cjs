const IDEA_IPC_CHANNELS = [
  "idea-bridge:snapshot",
  "idea-bridge:start",
  "idea-bridge:stop",
  "idea-bridge:stop-all",
  "idea-bridge:restart"
];

function ideaId(value, name) {
  const id = String(value || "").trim();
  if (!id || id.length > 512) throw new Error(`${name} is required.`);
  return id;
}

function registerIdeaIpcHandlers({ ipcMain, ideaService }) {
  ipcMain.handle("idea-bridge:snapshot", () => ideaService.getSnapshot());
  ipcMain.handle("idea-bridge:start", (_event, { bridgeId, projectId, configurationId, mode }) => {
    if (mode !== "run" && mode !== "debug") throw new Error("IDEA execution mode must be run or debug.");
    return ideaService.startConfiguration(
      ideaId(bridgeId, "bridgeId"),
      ideaId(projectId, "projectId"),
      ideaId(configurationId, "configurationId"),
      mode
    );
  });
  ipcMain.handle("idea-bridge:stop", (_event, { bridgeId, instanceId }) => {
    return ideaService.stopExecution(ideaId(bridgeId, "bridgeId"), ideaId(instanceId, "instanceId"));
  });
  ipcMain.handle("idea-bridge:stop-all", (_event, { bridgeId, projectId, configurationId }) => {
    return ideaService.stopAll(
      ideaId(bridgeId, "bridgeId"),
      ideaId(projectId, "projectId"),
      ideaId(configurationId, "configurationId")
    );
  });
  ipcMain.handle("idea-bridge:restart", (_event, { bridgeId, instanceId }) => {
    return ideaService.restartExecution(ideaId(bridgeId, "bridgeId"), ideaId(instanceId, "instanceId"));
  });

  return () => {
    for (const channel of IDEA_IPC_CHANNELS) {
      ipcMain.removeHandler(channel);
    }
  };
}

module.exports = {
  IDEA_IPC_CHANNELS,
  registerIdeaIpcHandlers
};
