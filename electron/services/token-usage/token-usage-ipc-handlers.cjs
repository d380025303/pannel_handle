const TOKEN_USAGE_IPC_CHANNELS = [
  "agent-usage:get",
  "agent-usage:get-codebuddy",
  "agent-usage:get-codex",
  "agent-usage:consume-reset-credit",
  "agent-token-stats:get",
  "agent-token-live:get",
  "agent-token-stats:clear"
];

function registerTokenUsageIpcHandlers({
  ipcMain,
  agentUsageService,
  agentTokenStatsStore,
  agentTokenStatsService,
  onStatsCleared = () => {}
}) {
  const canceledAsNull = promise => Promise.resolve(promise).catch(error => {
    if (error?.code === "USAGE_CANCELED") return null;
    throw error;
  });
  ipcMain.handle("agent-usage:get", (_event, { sessionId, force }) => {
    return canceledAsNull(agentUsageService.getUsage(sessionId, { force: Boolean(force) }));
  });

  ipcMain.handle("agent-usage:get-codebuddy", (_event, { force }) => {
    return canceledAsNull(agentUsageService.getCodeBuddyUsage({ force: Boolean(force) }));
  });

  ipcMain.handle("agent-usage:get-codex", (_event, { force }) => {
    return canceledAsNull(agentUsageService.getCodexUsage({ force: Boolean(force) }));
  });

  ipcMain.handle("agent-usage:consume-reset-credit", (_event, { sessionId, creditId, idempotencyKey }) => {
    return agentUsageService.consumeResetCredit(sessionId, { creditId, idempotencyKey });
  });

  const cancelUsage = (_event, { sessionId }) => {
    agentUsageService.disconnect(sessionId);
  };
  ipcMain.on("agent-usage:cancel", cancelUsage);
  const cancelCodeBuddyUsage = () => {
    agentUsageService.cancelCodeBuddyUsage();
  };
  ipcMain.on("agent-usage:cancel-codebuddy", cancelCodeBuddyUsage);
  const cancelCodexUsage = () => agentUsageService.cancelCodexUsage();
  ipcMain.on("agent-usage:cancel-codex", cancelCodexUsage);

  ipcMain.handle("agent-token-stats:get", (_event, options) => agentTokenStatsStore.getDashboard(options));
  ipcMain.handle("agent-token-live:get", (_event, { sessionId }) => agentTokenStatsService.getLive(sessionId));
  ipcMain.handle("agent-token-stats:clear", () => {
    agentTokenStatsStore.clear();
    onStatsCleared();
    return true;
  });

  return () => {
    for (const channel of TOKEN_USAGE_IPC_CHANNELS) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.removeListener("agent-usage:cancel", cancelUsage);
    ipcMain.removeListener("agent-usage:cancel-codebuddy", cancelCodeBuddyUsage);
    ipcMain.removeListener("agent-usage:cancel-codex", cancelCodexUsage);
  };
}

module.exports = {
  TOKEN_USAGE_IPC_CHANNELS,
  registerTokenUsageIpcHandlers
};
