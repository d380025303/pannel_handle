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

function sumUsageDetail(details, field) {
  if (!Array.isArray(details)) return 0;
  return details.reduce((total, detail) => total + safeInteger(detail?.[field]), 0);
}

function normalizeCodeBuddyUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = safeInteger(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = safeInteger(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens);
  const cachedInputTokens = safeInteger(
    usage.cachedInputTokens ??
    usage.cached_input_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    usage.prompt_cache_hit_tokens
  ) || sumUsageDetail(usage.inputTokensDetails, "cached_tokens");
  const reasoningOutputTokens = safeInteger(
    usage.reasoningOutputTokens ??
    usage.reasoning_output_tokens ??
    usage.completion_tokens_details?.reasoning_tokens ??
    usage.completion_thinking_tokens
  ) || sumUsageDetail(usage.outputTokensDetails, "reasoning_tokens");
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens: safeInteger(usage.cacheWriteInputTokens ?? usage.cache_creation_input_tokens ?? usage.prompt_cache_write_tokens),
    outputTokens,
    reasoningOutputTokens,
    totalTokens: safeInteger(usage.totalTokens ?? usage.total_tokens) || inputTokens + outputTokens
  };
}

function addTokens(target, source) {
  for (const field of TOKEN_FIELDS) target[field] += safeInteger(source?.[field]);
  return target;
}

function createIncrementalTranscriptParser(provider) {
  if (!['codex', 'codebuddy'].includes(provider)) {
    throw new Error(`Unsupported live token provider: ${provider}`);
  }
  let latestCodexTokens = null;
  const codeBuddyMessages = new Map();
  const models = new Set();

  function pushLine(line) {
    let item;
    try { item = JSON.parse(line); } catch { return false; }
    if (provider === "codex") {
      if (item?.type === "session_meta" && item.payload?.model) models.add(String(item.payload.model));
      if (item?.type !== "event_msg" || item.payload?.type !== "token_count") return false;
      const tokens = normalizeCodexUsage(item.payload.info?.total_token_usage ?? item.payload.info?.totalTokenUsage);
      if (!tokens) return false;
      latestCodexTokens = tokens;
      return true;
    }

    const providerData = item?.providerData;
    const usage = providerData?.usage ?? providerData?.rawUsage ?? item?.usage;
    const messageId = String(providerData?.messageId || item?.message?.id || "").trim();
    if (!usage || !messageId) return false;
    codeBuddyMessages.set(messageId, normalizeCodeBuddyUsage(usage));
    if (providerData?.model) models.add(String(providerData.model));
    return true;
  }

  function getResult() {
    if (provider === "codex") {
      return latestCodexTokens ? { tokens: cloneTokens(latestCodexTokens), models: [...models] } : null;
    }
    if (codeBuddyMessages.size === 0) return null;
    const tokens = emptyTokens();
    for (const usage of codeBuddyMessages.values()) addTokens(tokens, usage);
    return { tokens, models: [...models] };
  }

  return { pushLine, getResult };
}

function cloneTokens(tokens) {
  return Object.fromEntries(TOKEN_FIELDS.map(field => [field, safeInteger(tokens?.[field])]));
}

function parseTranscriptText(provider, text) {
  const lines = String(text || "").split(/\r?\n/).filter(Boolean);
  if (provider === "codex" || provider === "codebuddy") {
    const parser = createIncrementalTranscriptParser(provider);
    for (const line of lines) parser.pushLine(line);
    const result = parser.getResult();
    if (!result) throw new Error(`${provider === "codex" ? "Codex" : "CodeBuddy"} transcript does not contain token usage yet.`);
    return result;
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
  cloneTokens,
  createIncrementalTranscriptParser,
  emptyTokens,
  normalizeClaudeUsage,
  normalizeCodeBuddyUsage,
  normalizeCodexUsage,
  parseTranscriptFile,
  parseTranscriptText,
  safeInteger
};
