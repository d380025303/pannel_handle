const {
  createOpenRouterService,
  buildChatBridgeVerificationRequest,
  validateChatBridgeVerification
} = require("./openrouter-service.cjs");
const { transformMiniMaxModels } = require("./minimax-service.cjs");
const { MINIMAX_BASE_URL, MINIMAX_API_KEY_ENV } = require("../codex-model-bridge/index.cjs");
const { registerSettingsIpcHandlers } = require("./settings-ipc-handlers.cjs");
const { createOpenCodeGlobalModelSync } = require("../model-sources/opencode-global-model-sync.cjs");

function createSettingsModule({
  ipcMain,
  configStore,
  dingTalkConfigStore,
  dingTalkNotificationManager,
  workBuddyAutoCheckinService,
  getMobileRemoteService,
  openRouterConfigStore,
  naraRouterConfigStore,
  miniMaxConfigStore,
  codexModelBridgeModule,
  openRouterCatalogFile,
  naraRouterCatalogFile,
  miniMaxCatalogFile,
  dialog,
  getWindowFromEvent,
  userDataDir,
  listOpenCodeWslDistros = () => [],
  createRouterService = createOpenRouterService
}) {
  const openCodeModelSync = createOpenCodeGlobalModelSync({ userDataDir, stores: {
    openrouter: openRouterConfigStore, nararouter: naraRouterConfigStore, minimax: miniMaxConfigStore
  } });
  const onOpenCodeModelsChanged = () => {
    openCodeModelSync.syncWindows();
    for (const distro of new Set(listOpenCodeWslDistros())) openCodeModelSync.syncWsl(distro);
  };
  const openRouterService = createRouterService({
    store: openRouterConfigStore,
    catalogFile: openRouterCatalogFile,
    onOpenCodeModelsChanged
  });
  const naraRouterService = createRouterService({
    store: naraRouterConfigStore,
    catalogFile: naraRouterCatalogFile,
    providerId: "nararouter",
    providerName: "NaraRouter",
    baseUrl: "https://router.bynara.id/v1",
    apiKeyEnv: "NARAROUTER_API_KEY",
    modelsRequireApiKey: true,
    connectionTestPath: "/models",
    verificationHeaders: {},
    metadataBaseUrl: "https://router.bynara.id/api",
    responsesTransport: codexModelBridgeModule.getResponsesTransport("nararouter"),
    launchAdapter: codexModelBridgeModule.getLaunchAdapter("nararouter"),
    catalogCapabilities: { textOnly: true, reasoningSummaries: false },
    verificationRequestBuilder: buildChatBridgeVerificationRequest,
    verificationResultValidator: validateChatBridgeVerification,
    verificationStrategy: "all",
    onOpenCodeModelsChanged
  });
  const miniMaxService = createRouterService({
    store: miniMaxConfigStore,
    catalogFile: miniMaxCatalogFile,
    providerId: "minimax",
    providerName: "MiniMax",
    baseUrl: MINIMAX_BASE_URL,
    apiKeyEnv: MINIMAX_API_KEY_ENV,
    modelsRequireApiKey: true,
    connectionTestPath: "/models",
    verificationHeaders: {},
    responsesTransport: codexModelBridgeModule.getResponsesTransport("minimax"),
    launchAdapter: codexModelBridgeModule.getLaunchAdapter("minimax"),
    catalogCapabilities: { textOnly: true, reasoningSummaries: false, defaultContextWindow: 128000 },
    verificationRequestBuilder: buildChatBridgeVerificationRequest,
    verificationResultValidator: validateChatBridgeVerification,
    verificationStrategy: "all",
    transformModels: transformMiniMaxModels,
    onOpenCodeModelsChanged
  });
  const unregisterIpcHandlers = registerSettingsIpcHandlers({
    ipcMain,
    configStore,
    dingTalkConfigStore,
    dingTalkNotificationManager,
    workBuddyAutoCheckinService,
    openRouterService,
    naraRouterService,
    miniMaxService,
    miniMaxConfigStore,
    getMobileRemoteService,
    dialog,
    getWindowFromEvent,
    userDataDir
  });
  let stopped = false;

  return {
    openRouterService,
    naraRouterService,
    miniMaxService,
    openCodeModelSync,
    syncOpenCodeModels: onOpenCodeModelsChanged,
    shutdown() {
      if (stopped) return;
      stopped = true;
      unregisterIpcHandlers();
    }
  };
}

module.exports = {
  createSettingsModule
};
