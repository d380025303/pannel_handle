const fs = require("node:fs");

const TOKEN_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens"
];

function emptyTokens() {
  return Object.fromEntries(TOKEN_FIELDS.map(field => [field, 0]));
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function normalizeCodexUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = safeInteger(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = safeInteger(usage.output_tokens ?? usage.outputTokens);
  return {
    inputTokens,
    cachedInputTokens: safeInteger(usage.cached_input_tokens ?? usage.cachedInputTokens),
    cacheWriteInputTokens: safeInteger(usage.cache_write_input_tokens ?? usage.cacheWriteInputTokens),
    outputTokens,
    reasoningOutputTokens: safeInteger(usage.reasoning_output_tokens ?? usage.reasoningOutputTokens),
    totalTokens: safeInteger(usage.total_tokens ?? usage.totalTokens) || inputTokens + outputTokens
  };
}

function normalizeClaudeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const freshInput = safeInteger(usage.input_tokens ?? usage.inputTokens);
  const cachedInputTokens = safeInteger(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
  const cacheWriteInputTokens = safeInteger(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
  const inputTokens = freshInput + cachedInputTokens + cacheWriteInputTokens;
  const outputTokens = safeInteger(usage.output_tokens ?? usage.outputTokens);
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens
  };
}

function addTokens(target, source) {
  for (const field of TOKEN_FIELDS) target[field] += safeInteger(source?.[field]);
  return target;
}

function parseTranscriptText(provider, text) {
  const lines = String(text || "").split(/\r?\n/).filter(Boolean);
  if (provider === "codex") {
    let latest = null;
    const models = new Set();
    for (const line of lines) {
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      if (item?.type === "session_meta" && item.payload?.model) models.add(String(item.payload.model));
      if (item?.type === "event_msg" && item.payload?.type === "token_count") {
        latest = normalizeCodexUsage(item.payload.info?.total_token_usage ?? item.payload.info?.totalTokenUsage);
      }
    }
    if (!latest) throw new Error("Codex transcript does not contain token usage yet.");
    return { tokens: latest, models: [...models] };
  }

  if (provider === "claude") {
    const messages = new Map();
    const models = new Set();
    for (const line of lines) {
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      if (item?.type !== "assistant" || item.isSidechain === true || !item.message?.usage) continue;
      const messageId = String(item.message.id || item.uuid || "").trim();
      if (!messageId) continue;
      messages.set(messageId, normalizeClaudeUsage(item.message.usage));
      if (item.message.model) models.add(String(item.message.model));
    }
    if (messages.size === 0) throw new Error("Claude transcript does not contain token usage yet.");
    const totals = emptyTokens();
    for (const usage of messages.values()) addTokens(totals, usage);
    return { tokens: totals, models: [...models] };
  }

  throw new Error(`Unsupported token statistics provider: ${provider}`);
}

function parseTranscriptFile(provider, transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") throw new Error("Agent transcript path is unavailable.");
  return parseTranscriptText(provider, fs.readFileSync(transcriptPath, "utf-8"));
}

module.exports = {
  TOKEN_FIELDS,
  addTokens,
  emptyTokens,
  normalizeClaudeUsage,
  normalizeCodexUsage,
  parseTranscriptFile,
  parseTranscriptText,
  safeInteger
};
