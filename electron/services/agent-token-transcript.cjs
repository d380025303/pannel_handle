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

function emptyCapabilityUsage(availability = "available") {
  return {
    skills: { availability, totalCalls: 0, items: [] },
    mcp: { availability, totalCalls: 0, servers: [] }
  };
}

function normalizeCapabilityUsage(value, availability = "available") {
  const skills = new Map();
  for (const item of value?.skills?.items || []) {
    const name = normalizeCapabilityName(item?.name);
    if (name) skills.set(name, safeInteger(item.count));
  }
  const servers = new Map();
  for (const server of value?.mcp?.servers || []) {
    const serverName = normalizeCapabilityName(server?.name);
    if (!serverName) continue;
    const tools = new Map();
    for (const tool of server.tools || []) {
      const toolName = normalizeCapabilityName(tool?.name);
      if (toolName) tools.set(toolName, safeInteger(tool.count));
    }
    servers.set(serverName, tools);
  }
  const skillItems = [...skills].map(([name, count]) => ({ name, count })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  const mcpServers = [...servers].map(([name, tools]) => {
    const toolItems = [...tools].map(([toolName, count]) => ({ name: toolName, count })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
    return { name, count: toolItems.reduce((total, item) => total + item.count, 0), tools: toolItems };
  }).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  return {
    skills: {
      availability: ["available", "unavailable"].includes(value?.skills?.availability) ? value.skills.availability : availability,
      totalCalls: skillItems.reduce((total, item) => total + item.count, 0),
      items: skillItems
    },
    mcp: {
      availability: ["available", "unavailable"].includes(value?.mcp?.availability) ? value.mcp.availability : availability,
      totalCalls: mcpServers.reduce((total, server) => total + server.count, 0),
      servers: mcpServers
    }
  };
}

function capabilityMapSnapshot(skillCalls, mcpCalls) {
  return normalizeCapabilityUsage({
    skills: { availability: "available", items: [...skillCalls].map(([name, count]) => ({ name, count })) },
    mcp: {
      availability: "available",
      servers: [...mcpCalls].map(([name, tools]) => ({
        name,
        tools: [...tools].map(([toolName, count]) => ({ name: toolName, count }))
      }))
    }
  });
}

function splitMcpToolName(name) {
  const match = /^mcp__([A-Za-z0-9_-]{1,120})__([A-Za-z0-9_.:-]{1,160})$/.exec(String(name || ""));
  return match ? { server: match[1], tool: match[2] } : null;
}

function normalizeCapabilityName(name) {
  return String(name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160);
}

function skillNamesFromInput(input) {
  const text = typeof input === "string" ? input : JSON.stringify(input || {});
  const normalized = text.replace(/\\\\/g, "/").replace(/\\/g, "/");
  const names = new Set();
  const pattern = /\/skills\/(?:[^\s"'`/]+\/)*([^\s"'`/]+)\/SKILL\.md/gi;
  for (const match of normalized.matchAll(pattern)) names.add(match[1]);
  return [...names];
}

function createIncrementalTranscriptParser(provider) {
  if (!["codex", "claude", "codebuddy"].includes(provider)) {
    throw new Error(`Unsupported live token provider: ${provider}`);
  }
  let latestCodexTokens = null;
  const claudeMessages = new Map();
  const codeBuddyMessages = new Map();
  const models = new Set();
  const skillCalls = new Map();
  const mcpCalls = new Map();
  const seenCalls = new Set();
  let anonymousCallIndex = 0;

  function incrementSkill(name) {
    const normalized = normalizeCapabilityName(name);
    if (normalized) skillCalls.set(normalized, 1 + (skillCalls.get(normalized) || 0));
  }

  function incrementMcp(name) {
    const parsed = splitMcpToolName(name);
    if (!parsed) return;
    if (!mcpCalls.has(parsed.server)) mcpCalls.set(parsed.server, new Map());
    const tools = mcpCalls.get(parsed.server);
    tools.set(parsed.tool, 1 + (tools.get(parsed.tool) || 0));
  }

  function recordToolCall(name, input, id, index = 0) {
    const normalizedName = String(name || "").trim();
    const key = String(id || `anonymous:${anonymousCallIndex++}`).trim();
    const dedupeKey = `${key}:${index}`;
    if (seenCalls.has(dedupeKey)) return false;
    seenCalls.add(dedupeKey);
    let changed = false;
    if (splitMcpToolName(normalizedName)) {
      incrementMcp(normalizedName);
      changed = true;
    }
    if (/^skill$/i.test(normalizedName)) {
      const skillName = input?.skill || input?.name;
      if (skillName) {
        incrementSkill(skillName);
        changed = true;
      }
    }
    for (const skillName of skillNamesFromInput(input)) {
      incrementSkill(skillName);
      changed = true;
    }
    return changed;
  }

  function recordCodexTools(item) {
    if (item?.type !== "response_item") return false;
    const payload = item.payload || {};
    if (payload.type !== "function_call" && payload.type !== "custom_tool_call") return false;
    const callId = payload.call_id || payload.id || item.id;
    let changed = recordToolCall(payload.name, payload.arguments ?? payload.input, callId);
    if (payload.type === "custom_tool_call") {
      const input = String(payload.input || "");
      let index = 1;
      for (const match of input.matchAll(/tools\.(mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+)\s*\(/g)) {
        changed = recordToolCall(match[1], {}, callId, index++) || changed;
      }
    }
    return changed;
  }

  function recordClaudeTools(item) {
    if (item?.type !== "assistant" || item.isSidechain === true) return false;
    let changed = false;
    for (const content of Array.isArray(item.message?.content) ? item.message.content : []) {
      if (content?.type !== "tool_use") continue;
      changed = recordToolCall(content.name, content.input, content.id || item.uuid) || changed;
    }
    return changed;
  }

  function recordCodeBuddyTools(item) {
    const providerData = item?.providerData || {};
    const name = item?.name || item?.tool_name || providerData.name || providerData.toolName;
    if (!name && item?.type !== "function_call" && item?.type !== "tool_use") return false;
    return recordToolCall(name, item?.input || item?.arguments || providerData.input || providerData.arguments, providerData.callId || item?.call_id || item?.id);
  }

  function pushLine(line) {
    let item;
    try { item = JSON.parse(line); } catch { return false; }
    if (provider === "codex") {
      const capabilityChanged = recordCodexTools(item);
      if (item?.type === "session_meta" && item.payload?.model) models.add(String(item.payload.model));
      if (item?.type !== "event_msg" || item.payload?.type !== "token_count") return capabilityChanged;
      const tokens = normalizeCodexUsage(item.payload.info?.total_token_usage ?? item.payload.info?.totalTokenUsage);
      if (!tokens) return capabilityChanged;
      latestCodexTokens = tokens;
      return true;
    }

    if (provider === "claude") {
      const capabilityChanged = recordClaudeTools(item);
      if (item?.type !== "assistant" || item.isSidechain === true || !item.message?.usage) return capabilityChanged;
      const messageId = String(item.message.id || item.uuid || "").trim();
      if (!messageId) return capabilityChanged;
      claudeMessages.set(messageId, normalizeClaudeUsage(item.message.usage));
      if (item.message.model) models.add(String(item.message.model));
      return true;
    }

    const providerData = item?.providerData;
    const capabilityChanged = recordCodeBuddyTools(item);
    const usage = providerData?.usage ?? providerData?.rawUsage ?? item?.usage;
    const messageId = String(providerData?.messageId || item?.message?.id || "").trim();
    if (!usage || !messageId) return capabilityChanged;
    codeBuddyMessages.set(messageId, normalizeCodeBuddyUsage(usage));
    if (providerData?.model) models.add(String(providerData.model));
    return true;
  }

  function getResult() {
    const capabilities = capabilityMapSnapshot(skillCalls, mcpCalls);
    if (provider === "codex") {
      return latestCodexTokens || capabilities.skills.totalCalls || capabilities.mcp.totalCalls
        ? { tokens: cloneTokens(latestCodexTokens || emptyTokens()), models: [...models], capabilities }
        : null;
    }
    const messages = provider === "claude" ? claudeMessages : codeBuddyMessages;
    if (messages.size === 0 && !capabilities.skills.totalCalls && !capabilities.mcp.totalCalls) return null;
    const tokens = emptyTokens();
    for (const usage of messages.values()) addTokens(tokens, usage);
    return { tokens, models: [...models], capabilities };
  }

  return { pushLine, getResult };
}

function cloneTokens(tokens) {
  return Object.fromEntries(TOKEN_FIELDS.map(field => [field, safeInteger(tokens?.[field])]));
}

function parseTranscriptText(provider, text) {
  const lines = String(text || "").split(/\r?\n/).filter(Boolean);
  if (["codex", "claude", "codebuddy"].includes(provider)) {
    const parser = createIncrementalTranscriptParser(provider);
    for (const line of lines) parser.pushLine(line);
    const result = parser.getResult();
    if (!result) throw new Error(`${provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : "CodeBuddy"} transcript does not contain usage yet.`);
    return result;
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
  emptyCapabilityUsage,
  emptyTokens,
  normalizeClaudeUsage,
  normalizeCodeBuddyUsage,
  normalizeCapabilityUsage,
  normalizeCodexUsage,
  parseTranscriptFile,
  parseTranscriptText,
  safeInteger
};
