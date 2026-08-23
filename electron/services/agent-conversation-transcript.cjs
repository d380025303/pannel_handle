function getText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter(item => item && (item.type === "input_text" || item.type === "output_text" || item.type === "text") && typeof item.text === "string")
    .map(item => item.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function normalizeTimestamp(value) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function createAgentConversationTranscriptParser(provider, options = {}) {
  if (provider !== "codex" && provider !== "codebuddy" && provider !== "gemini") {
    throw new Error(`Unsupported Agent conversation provider: ${provider}`);
  }

  const seenMessageIds = new Set();

  function parseCodex(item) {
    if (item?.type !== "response_item") return null;
    const payload = item.payload || {};
    if (payload.type !== "message") return null;
    const isUser = payload.role === "user";
    if (isUser && !options.includeUser) return null;
    if (!isUser && payload.role !== "assistant") return null;
    const assistantKind = payload.phase === "commentary"
      ? "commentary"
      : payload.phase === "final" || payload.phase === "final_answer"
        ? "final"
        : null;
    if (!isUser && !assistantKind) return null;
    const text = getText(payload.content);
    if (!text) return null;
    return {
      id: String(payload.id || item.id || `${isUser ? "user" : assistantKind}:${text}`),
      provider,
      kind: isUser ? "user" : assistantKind,
      text,
      timestamp: normalizeTimestamp(item.timestamp)
    };
  }

  function parseCodeBuddy(item) {
    if (item?.type !== "message") return null;
    const isUser = item.role === "user";
    if (isUser && !options.includeUser) return null;
    if (!isUser && item.role !== "assistant") return null;
    const text = getText(item.content);
    if (!text) return null;
    return {
      id: String(item.providerData?.messageId || item.id || `${isUser ? "user" : "reply"}:${text}`),
      provider,
      kind: isUser ? "user" : "reply",
      text,
      timestamp: normalizeTimestamp(item.timestamp)
    };
  }

  function parseGemini(item) {
    if (item?.type !== "user" && item?.type !== "gemini") return null;
    const isUser = item.type === "user";
    if (isUser && !options.includeUser) return null;
    const text = typeof item.content === "string" ? item.content.trim() : getText(item.content);
    if (!text) return null;
    return {
      id: String(item.id || `${item.type}:${text}`),
      provider,
      kind: isUser ? "user" : "reply",
      text,
      timestamp: normalizeTimestamp(item.timestamp)
    };
  }

  function pushLine(line) {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      return [];
    }
    if (provider === "gemini" && Array.isArray(item?.$set?.messages)) {
      const output = [];
      for (const entry of item.$set.messages) {
        const message = parseGemini(entry);
        if (message && !seenMessageIds.has(message.id)) {
          seenMessageIds.add(message.id);
          output.push(message);
        }
      }
      return output;
    }
    const message = provider === "codex" ? parseCodex(item) : provider === "gemini" ? parseGemini(item) : parseCodeBuddy(item);
    if (!message || seenMessageIds.has(message.id)) return [];
    seenMessageIds.add(message.id);
    return [message];
  }

  return { pushLine };
}

function parseAgentConversationText(provider, text, options = {}) {
  const parser = createAgentConversationTranscriptParser(provider, options);
  const messages = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.trim()) messages.push(...parser.pushLine(line));
  }
  return messages;
}

module.exports = {
  createAgentConversationTranscriptParser,
  getText,
  normalizeTimestamp,
  parseAgentConversationText
};
