const { createGeminiMessageState } = require("./gemini-message-state.cjs");
const { getGrokChunkText } = require("./grok-chunk-text.cjs");

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
  if (provider !== "codex" && provider !== "codebuddy" && provider !== "gemini" && provider !== "grok") {
    throw new Error(`Unsupported Agent conversation provider: ${provider}`);
  }

  const seenMessageIds = new Set();
  let recordIndex = 0;
  const geminiState = provider === "gemini" ? createGeminiMessageState() : null;
  let replacement = false;

  function parseCodex(item) {
    if (item?.type === "compacted") {
      const text = typeof item.payload?.message === "string" ? item.payload.message.trim() : "";
      if (!text) return null;
      return { id: String(item.id || `summary:${item.timestamp || ""}:${text}`), provider, kind: "summary",
        text, timestamp: normalizeTimestamp(item.timestamp) };
    }
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
      id: String(payload.id || item.id || `${isUser ? "user" : assistantKind}:${item.timestamp ?? ""}:${recordIndex}:${text}`),
      provider,
      kind: isUser ? "user" : assistantKind,
      text,
      timestamp: normalizeTimestamp(item.timestamp)
    };
  }

  function parseCodeBuddy(item) {
    if (item?.type === "summary") {
      const text = typeof item.summary === "string" ? item.summary.trim() : "";
      if (!text) return null;
      return { id: String(item.id || `summary:${item.timestamp || ""}:${text}`), provider, kind: "summary",
        text, timestamp: normalizeTimestamp(item.timestamp) };
    }
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

  function parseGrok(item) {
    const params = item?.params || {};
    const update = params.update || {};
    const updateType = update.sessionUpdate;
    const isUser = updateType === "user_message_chunk";
    if (!isUser && updateType !== "agent_message_chunk") return null;
    if (isUser && !options.includeUser) return null;
    const text = getGrokChunkText(update.content);
    if (!text) return null;
    const meta = params._meta || {};
    return {
      id: String(meta.eventId || `${meta.promptId || "turn"}:${meta.chunkId || item.timestamp || text}`),
      provider,
      kind: isUser ? "user" : "reply",
      text,
      timestamp: normalizeTimestamp(item.timestamp)
    };
  }

  function pushLine(line) {
    replacement = false;
    recordIndex += 1;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      return [];
    }
    if (geminiState) {
      const operation = geminiState.apply(item);
      if (!operation) return [];
      replacement = operation === "replace";
      return (replacement ? geminiState.getMessages() : [item]).map(parseGemini).filter(Boolean);
    }
    const message = provider === "codex" ? parseCodex(item) : provider === "grok" ? parseGrok(item) : parseCodeBuddy(item);
    if (!message || seenMessageIds.has(message.id)) return [];
    seenMessageIds.add(message.id);
    return [message];
  }

  function pushUpdate(line) {
    const messages = pushLine(line);
    return { messages, replace: replacement };
  }

  return { pushLine, pushUpdate };
}

function parseAgentConversationText(provider, text, options = {}) {
  const parser = createAgentConversationTranscriptParser(provider, options);
  const messages = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const update = parser.pushUpdate(line);
    if (update.replace) messages.length = 0;
    messages.push(...update.messages);
  }
  return messages;
}

module.exports = {
  createAgentConversationTranscriptParser,
  getText,
  normalizeTimestamp,
  parseAgentConversationText
};
