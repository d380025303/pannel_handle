const { buildCodexBackendCommand } = require("./codex-command.cjs");
const { createResponsesChatCompletionsBridgeService } = require("./responses-chat-completions-bridge-service.cjs");
const {
  MINIMAX_BASE_URL,
  MINIMAX_CHAT_COMPLETIONS_URL,
  MINIMAX_API_KEY_ENV,
  MINIMAX_MAX_COMPLETION_TOKENS,
  adaptMiniMaxChatRequest
} = require("./minimax-adapter.cjs");

const NARAROUTER_BRIDGE_API_KEY_ENV = "PANNEL_HANDLE_NARAROUTER_BRIDGE_KEY";

function createCodexModelBridgeModule({
  createResponsesBridge = createResponsesChatCompletionsBridgeService
}) {
  const bridges = {
    nararouter: createResponsesBridge({
      providerId: "nararouter",
      providerName: "NaraRouter",
      upstreamUrl: "https://router.bynara.id/v1/chat/completions",
      apiKeyEnv: NARAROUTER_BRIDGE_API_KEY_ENV,
      ignoredToolTypes: ["web_search", "web_search_preview"]
    }),
    minimax: createResponsesBridge({
      providerId: "minimax",
      providerName: "MiniMax",
      upstreamUrl: MINIMAX_CHAT_COMPLETIONS_URL,
      apiKeyEnv: MINIMAX_API_KEY_ENV,
      ignoredToolTypes: ["web_search", "web_search_preview"],
      requestAdapter: adaptMiniMaxChatRequest,
      allowFinishReasonAsDone: true
    })
  };

  function getBridge(backend) {
    const bridge = bridges[backend];
    if (!bridge) throw new Error(`Unsupported Codex bridge backend: ${backend}.`);
    return bridge;
  }

  function getResponsesTransport(backend) {
    const bridge = getBridge(backend);
    if (typeof bridge.fetchResponses !== "function") throw new Error(`${backend} does not expose a verification transport.`);
    return input => bridge.fetchResponses(input);
  }

  function getLaunchAdapter(backend) {
    const bridge = getBridge(backend);
    return async (session, config) => {
      const launch = await bridge.getLaunchConfig(session, config);
      return launch ? { ...launch, bridgeRegistration: { backend, id: launch.registrationId } } : launch;
    };
  }

  function bindSession(sessionId, registration) {
    if (registration?.id) getBridge(registration.backend).bindSession(sessionId, registration.id);
  }

  function releaseRegistration(registration) {
    if (registration?.id) getBridge(registration.backend).releaseRegistration?.(registration.id);
  }

  function disconnect(sessionId) {
    for (const bridge of Object.values(bridges)) bridge.disconnect(sessionId);
  }

  async function shutdown() {
    await Promise.all(Object.values(bridges).map(bridge => bridge.shutdown()));
  }

  return {
    getResponsesTransport,
    getLaunchAdapter,
    bindSession,
    releaseRegistration,
    disconnect,
    shutdown
  };
}

module.exports = {
  NARAROUTER_BRIDGE_API_KEY_ENV,
  MINIMAX_BASE_URL,
  MINIMAX_CHAT_COMPLETIONS_URL,
  MINIMAX_API_KEY_ENV,
  MINIMAX_MAX_COMPLETION_TOKENS,
  adaptMiniMaxChatRequest,
  buildCodexBackendCommand,
  createCodexModelBridgeModule,
  createResponsesChatCompletionsBridgeService
};
