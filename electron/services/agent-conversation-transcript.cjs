function getText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter(item => item && (item.type === "output_text" || item.type === "text") && typeof item.text === "string")
    .map(item => item.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function createAgentConversationTranscriptParser(provider) {
  if (provider !== "codex" && provider !== "codebuddy") {
    throw new Error(`Unsupported Agent conversation provider: ${provider}`);
  }

  const seenMessageIds = new Set();

  function parseCodex(item) {
    if (item?.type !== "response_item") return null;
    const payload = item.payload || {};
    if (payload.type !== "message" || payload.role !== "assistant") return null;
    if (payload.phase !== "commentary" && payload.phase !== "final") return null;
    const text = getText(payload.content);
    if (!text) return null;
    return {
      id: String(payload.id || item.id || `${payload.phase}:${text}`),
      provider,
      kind: payload.phase,
      text,
      timestamp: Date.parse(item.timestamp) || Date.now()
    };
  }

  function parseCodeBuddy(item) {
    if (item?.type !== "message" || item.role !== "assistant") return null;
    const text = getText(item.content);
    if (!text) return null;
    return {
      id: String(item.providerData?.messageId || item.id || `reply:${text}`),
      provider,
      kind: "reply",
      text,
      timestamp: Date.parse(item.timestamp) || Date.now()
    };
  }

  function pushLine(line) {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      return [];
    }
    const message = provider === "codex" ? parseCodex(item) : parseCodeBuddy(item);
    if (!message || seenMessageIds.has(message.id)) return [];
    seenMessageIds.add(message.id);
    return [message];
  }

  return { pushLine };
}

module.exports = {
  createAgentConversationTranscriptParser,
  getText
};
