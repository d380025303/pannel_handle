const TOKEN_USAGE_IPC_CHANNELS = [
  "agent-usage:get",
  "agent-usage:consume-reset-credit",
  "agent-token-stats:get",
  "agent-token-live:get",
  "agent-token-stats:clear"
];

function registerTokenUsageIpcHandlers({
  ipcMain,
  agentUsageService,
  agentTokenStatsStore,
  agentTokenStatsService
}) {
  ipcMain.handle("agent-usage:get", (_event, { sessionId, force }) => {
    return agentUsageService.getUsage(sessionId, { force: Boolean(force) });
  });

  ipcMain.handle("agent-usage:consume-reset-credit", (_event, { sessionId, creditId, idempotencyKey }) => {
    return agentUsageService.consumeResetCredit(sessionId, { creditId, idempotencyKey });
  });

  const cancelUsage = (_event, { sessionId }) => {
    agentUsageService.disconnect(sessionId);
  };
  ipcMain.on("agent-usage:cancel", cancelUsage);

  ipcMain.handle("agent-token-stats:get", (_event, options) => agentTokenStatsStore.getDashboard(options));
  ipcMain.handle("agent-token-live:get", (_event, { sessionId }) => agentTokenStatsService.getLive(sessionId));
  ipcMain.handle("agent-token-stats:clear", () => {
    agentTokenStatsStore.clear();
    return true;
  });

  return () => {
    for (const channel of TOKEN_USAGE_IPC_CHANNELS) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.removeListener("agent-usage:cancel", cancelUsage);
  };
}

module.exports = {
  TOKEN_USAGE_IPC_CHANNELS,
  registerTokenUsageIpcHandlers
};
