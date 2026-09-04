const {
  createOpenRouterService,
  buildChatBridgeVerificationRequest,
  validateChatBridgeVerification
} = require("./openrouter-service.cjs");
const { transformMiniMaxModels } = require("./minimax-service.cjs");
const { MINIMAX_BASE_URL, MINIMAX_API_KEY_ENV } = require("../codex-model-bridge/index.cjs");
const { registerSettingsIpcHandlers } = require("./settings-ipc-handlers.cjs");

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
  codeBuddyCodexBridgeService,
  codexModelBridgeModule,
  openRouterCatalogFile,
  naraRouterCatalogFile,
  miniMaxCatalogFile,
  createRouterService = createOpenRouterService
}) {
  const openRouterService = createRouterService({
    store: openRouterConfigStore,
    catalogFile: openRouterCatalogFile
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
    verificationStrategy: "all"
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
    transformModels: transformMiniMaxModels
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
    codeBuddyCodexBridgeService,
    getMobileRemoteService
  });
  let stopped = false;

  return {
    openRouterService,
    naraRouterService,
    miniMaxService,
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
