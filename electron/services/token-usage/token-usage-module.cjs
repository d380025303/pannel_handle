const { createAgentUsageService } = require("./agent-usage-service.cjs");
const { createAgentTokenStatsService } = require("./agent-token-stats-service.cjs");
const { createAgentTokenStatsStore } = require("./agent-token-stats-store.cjs");
const { registerTokenUsageIpcHandlers } = require("./token-usage-ipc-handlers.cjs");

function createTokenUsageModule({
  ipcMain,
  terminalManager,
  sshAgentTransport,
  miniMaxConfigStore,
  databaseFile,
  legacyStatsFile,
  broadcast,
  conversationSink,
  onStatsChanged = () => {},
  onStatsCleared = () => {},
  createUsageService = createAgentUsageService,
  createStatsService = createAgentTokenStatsService,
  createStatsStore = createAgentTokenStatsStore,
  registerIpcHandlers = registerTokenUsageIpcHandlers
}) {
  const statsStore = createStatsStore({
    databaseFile,
    legacyStatsFile,
    onChanged: () => { broadcast("agent-token-stats:changed", { timestamp: Date.now() }); onStatsChanged(); }
  });
  statsStore.load();

  const usageService = createUsageService({
    terminalManager,
    sshAgentTransport,
    miniMaxConfigStore
  });
  const statsService = createStatsService({
    terminalManager,
    statsStore,
    sshAgentTransport,
    broadcast,
    conversationSink
  });
  const unregisterIpcHandlers = registerIpcHandlers({
    ipcMain,
    agentUsageService: usageService,
    agentTokenStatsStore: statsStore,
    agentTokenStatsService: statsService,
    onStatsCleared
  });
  let stopped = false;

  function handleHook(input) {
    return statsService.handleHook(input);
  }

  function recordAppServerUsage({ threadId, session, cwd, model, tokens, baseline = false }) {
    if (stopped || !threadId || !session || !tokens) return;
    const agentSessionId = `app-server:${threadId}`;
    if (baseline) statsStore.setBaseline("codex", agentSessionId, tokens);
    statsStore.update({
      provider: "codex",
      agentSessionId,
      panelSessionId: session.id,
      templateId: session.templateId,
      title: session.title,
      cwd: cwd || session.cwd,
      location: session.type,
      models: model ? [model] : [],
      tokens
    });
  }

  function recordGraphicalCodeBuddy(input) {
    if (stopped) return Promise.resolve();
    return statsService.recordGraphicalCodeBuddy(input);
  }

  function resetGraphicalCodeBuddyBaselines() {
    statsService.resetGraphicalCodeBuddyBaselines();
  }

  function disconnect(sessionId) {
    usageService.disconnect(sessionId);
    statsService.markEnded(sessionId);
  }

  function shutdown() {
    if (stopped) return;
    stopped = true;
    unregisterIpcHandlers();
    usageService.shutdown();
    statsService.shutdown();
    statsStore.close();
  }

  return {
    disconnect,
    handleHook,
    recordAppServerUsage,
    recordGraphicalCodeBuddy,
    resetGraphicalCodeBuddyBaselines,
    getDashboard: options => statsStore.getDashboard(options),
    shutdown
  };
}

module.exports = {
  createTokenUsageModule
};
