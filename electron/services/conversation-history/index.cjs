// Load only the requested capability: shared parsers/clients do not load service orchestration.
module.exports = {
  get createAgentConversationHistoryService() {
    return require("./agent-conversation-history-service.cjs").createAgentConversationHistoryService;
  },
  get createAgentConversationTranscriptParser() {
    return require("./agent-conversation-transcript.cjs").createAgentConversationTranscriptParser;
  },
  get parseAgentConversationText() {
    return require("./agent-conversation-transcript.cjs").parseAgentConversationText;
  }
};
