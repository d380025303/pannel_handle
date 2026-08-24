const fs = require("node:fs");
const path = require("node:path");

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

function normalizeQoderTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const freshInput = safeInteger(usage.input_tokens ?? usage.inputTokens);
  const cachedInputTokens = safeInteger(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
  const cacheWriteInputTokens = safeInteger(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
  const outputTokens = safeInteger(usage.output_tokens ?? usage.outputTokens);
  const totalTokenSum = freshInput + cachedInputTokens + cacheWriteInputTokens + outputTokens;
  // Qoder 转录里的 token 字段恒为 0，实际按 credits 计费；token 全为 0 且有 credits 时回落到 credits。
  if (totalTokenSum === 0) {
    const credits = Number(usage.credits ?? usage.original_credits);
    if (Number.isFinite(credits) && credits > 0) {
      const creditTokens = Math.round(credits);
      return {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: creditTokens,
        reasoningOutputTokens: 0,
        totalTokens: creditTokens
      };
    }
  }
  const inputTokens = freshInput + cachedInputTokens + cacheWriteInputTokens;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens
  };
}

function normalizeGeminiUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const reportedInput = safeInteger(usage.input ?? usage.inputTokens ?? usage.promptTokenCount);
  const cachedInputTokens = safeInteger(usage.cached ?? usage.cachedInputTokens ?? usage.cachedContentTokenCount);
  const inputTokens = Math.max(0, reportedInput - cachedInputTokens);
  const outputTokens = safeInteger(usage.output ?? usage.outputTokens ?? usage.candidatesTokenCount);
  const reasoningOutputTokens = safeInteger(usage.thoughts ?? usage.reasoningOutputTokens ?? usage.thoughtsTokenCount);
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: safeInteger(usage.total ?? usage.totalTokens ?? usage.totalTokenCount) || reportedInput + outputTokens
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
    if (name) skills.set(name, (skills.get(name) || 0) + safeInteger(item.count));
  }
  const servers = new Map();
  for (const server of value?.mcp?.servers || []) {
    const serverName = normalizeCapabilityName(server?.name);
    if (!serverName) continue;
    let tools = servers.get(serverName);
    if (!tools) {
      tools = new Map();
      servers.set(serverName, tools);
    }
    for (const tool of server.tools || []) {
      const toolName = normalizeCapabilityName(tool?.name);
      if (toolName) tools.set(toolName, (tools.get(toolName) || 0) + safeInteger(tool.count));
    }
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
  const hasReadIntent = /(?:\bGet-Content\b|\breadFile(?:Sync)?\s*\(|(?:^|[\s;&|])(?:cat|type|sed|head|tail|bat)(?:\.exe)?\s)/i.test(text);
  if (!hasReadIntent) return [];
  const normalized = text.replace(/\\\\/g, "/").replace(/\\/g, "/");
  const names = new Set();
  const pattern = /\/skills\/(?:[^\s"'`/]+\/)*([^\s"'`/]+)\/SKILL\.md/gi;
  for (const match of normalized.matchAll(pattern)) names.add(match[1]);
  return [...names];
}

function skillNamesFromInjectedMessage(payload) {
  if (payload?.type !== "message" || payload.role !== "user") return [];
  const content = Array.isArray(payload.content)
    ? payload.content.map(part => typeof part === "string" ? part : part?.text || "").join("\n")
    : String(payload.content || "");
  const names = new Set();
  for (const block of content.matchAll(/<skill>([\s\S]*?)<\/skill>/gi)) {
    const name = /<name>\s*([^<]+?)\s*<\/name>/i.exec(block[1])?.[1];
    const normalized = normalizeCapabilityName(name);
    if (normalized) names.add(normalized);
  }
  return [...names];
}

function codexToolOutputSucceeded(payload) {
  if (payload?.isError === true || payload?.is_error === true || /^(?:failed|error)$/i.test(String(payload?.status || ""))) return false;
  const output = typeof payload?.output === "string" ? payload.output : JSON.stringify(payload?.output ?? "");
  return !/(?:Script failed|Script error|Exit code:\s*[1-9]\d*|Process exited with code\s+[1-9]\d*)/i.test(output);
}

function createIncrementalTranscriptParser(provider) {
  if (!["codex", "claude", "codebuddy", "qoder", "gemini"].includes(provider)) {
    throw new Error(`Unsupported live token provider: ${provider}`);
  }
  let latestCodexTokens = null;
  const claudeMessages = new Map();
  const codeBuddyMessages = new Map();
  const qoderMessages = new Map();
  const geminiMessages = new Map();
  const models = new Set();
  const skillCalls = new Map();
  const mcpCalls = new Map();
  const seenCalls = new Set();
  const pendingSkillReads = new Map();
  let anonymousCallIndex = 0;

  function incrementSkill(name) {
    const normalized = normalizeCapabilityName(name);
    if (!normalized || skillCalls.has(normalized)) return false;
    skillCalls.set(normalized, 1);
    return true;
  }

  function incrementMcp(name) {
    const parsed = splitMcpToolName(name);
    if (!parsed) return;
    if (!mcpCalls.has(parsed.server)) mcpCalls.set(parsed.server, new Map());
    const tools = mcpCalls.get(parsed.server);
    tools.set(parsed.tool, 1 + (tools.get(parsed.tool) || 0));
  }

  function recordToolCall(name, input, id, index = 0, { deferSkillReads = false } = {}) {
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
      if (skillName) changed = incrementSkill(skillName) || changed;
    }
    const skillNames = skillNamesFromInput(input);
    if (deferSkillReads && skillNames.length) {
      pendingSkillReads.set(key, skillNames);
    } else {
      for (const skillName of skillNames) changed = incrementSkill(skillName) || changed;
    }
    return changed;
  }

  function recordCodexTools(item) {
    if (item?.type !== "response_item") return false;
    const payload = item.payload || {};
    if (payload.type === "message") {
      let changed = false;
      for (const skillName of skillNamesFromInjectedMessage(payload)) changed = incrementSkill(skillName) || changed;
      return changed;
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const callId = String(payload.call_id || payload.id || "").trim();
      const skillNames = pendingSkillReads.get(callId);
      if (!skillNames) return false;
      pendingSkillReads.delete(callId);
      if (!codexToolOutputSucceeded(payload)) return false;
      let changed = false;
      for (const skillName of skillNames) changed = incrementSkill(skillName) || changed;
      return changed;
    }
    if (payload.type !== "function_call" && payload.type !== "custom_tool_call") return false;
    const callId = payload.call_id || payload.id || item.id;
    let changed = recordToolCall(payload.name, payload.arguments ?? payload.input, callId, 0, { deferSkillReads: true });
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

  function recordGeminiMessage(item) {
    if (!item || item.type !== "gemini") return false;
    const messageId = String(item.id || "").trim();
    if (!messageId) return false;
    geminiMessages.set(messageId, normalizeGeminiUsage(item.tokens));
    if (item.model) models.add(String(item.model));
    for (const [index, call] of (Array.isArray(item.toolCalls) ? item.toolCalls : []).entries()) {
      recordToolCall(call?.name, call?.args ?? call?.arguments, call?.id || messageId, index);
    }
    return true;
  }

  function applyGeminiRecord(item) {
    if (Array.isArray(item?.$set?.messages)) {
      geminiMessages.clear();
      for (const message of item.$set.messages) recordGeminiMessage(message);
      return true;
    }
    const rewindId = item?.$rewindTo?.id ?? item?.$rewindTo;
    if (rewindId) {
      let remove = false;
      for (const id of [...geminiMessages.keys()]) {
        if (id === String(rewindId)) remove = true;
        if (remove) geminiMessages.delete(id);
      }
      return true;
    }
    return recordGeminiMessage(item);
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

    if (provider === "qoder") {
      const capabilityChanged = recordClaudeTools(item);
      if (item?.type !== "assistant" || !item.message?.usage) return capabilityChanged;
      const messageId = String(item.message.id || item.uuid || "").trim();
      if (!messageId) return capabilityChanged;
      qoderMessages.set(messageId, normalizeQoderTokenUsage(item.message.usage));
      if (item.message.model) models.add(String(item.message.model));
      return true;
    }

    if (provider === "gemini") return applyGeminiRecord(item);

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
    const messages = provider === "claude"
      ? claudeMessages
      : provider === "qoder"
        ? qoderMessages
        : provider === "gemini"
          ? geminiMessages
          : codeBuddyMessages;
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
  if (["codex", "claude", "codebuddy", "qoder", "gemini"].includes(provider)) {
    const parser = createIncrementalTranscriptParser(provider);
    if (provider === "gemini") {
      try {
        const legacy = JSON.parse(String(text || ""));
        if (Array.isArray(legacy)) {
          parser.pushLine(JSON.stringify({ $set: { messages: legacy } }));
          const result = parser.getResult();
          if (result) return result;
        } else if (Array.isArray(legacy?.messages)) {
          parser.pushLine(JSON.stringify({ $set: { messages: legacy.messages } }));
          const result = parser.getResult();
          if (result) return result;
        }
      } catch { /* Current Gemini transcripts are JSONL. */ }
    }
    for (const line of lines) parser.pushLine(line);
    const result = parser.getResult();
    if (!result) throw new Error(`${provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : provider === "qoder" ? "Qoder" : provider === "gemini" ? "Gemini CLI" : "CodeBuddy"} transcript does not contain usage yet.`);
    return result;
  }

  throw new Error(`Unsupported token statistics provider: ${provider}`);
}

function parseTranscriptFile(provider, transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") throw new Error("Agent transcript path is unavailable.");
  return parseTranscriptText(provider, fs.readFileSync(transcriptPath, "utf-8"));
}

// CodeBuddy 把子 agent（Task/Agent tool）的 transcript 写在主 transcript 同级的
// `<sessionId>/subagents/agent-*.jsonl` 中，主 transcript 不包含子 agent 的 usage。
function getCodeBuddySubagentsDir(transcriptPath) {
  const parsed = path.parse(String(transcriptPath || ""));
  if (!parsed.dir || parsed.ext.toLowerCase() !== ".jsonl") return null;
  return path.join(parsed.dir, parsed.name, "subagents");
}

function listCodeBuddySubagentFiles(transcriptPath) {
  const subagentsDir = getCodeBuddySubagentsDir(transcriptPath);
  if (!subagentsDir) return [];
  let entries;
  try { entries = fs.readdirSync(subagentsDir); } catch { return []; }
  return entries
    .filter(name => name.toLowerCase().endsWith(".jsonl"))
    .sort()
    .map(name => path.join(subagentsDir, name));
}

function mergeTranscriptResults(results) {
  const tokens = emptyTokens();
  const models = new Set();
  const skillItems = [];
  const mcpServers = [];
  for (const result of results) {
    addTokens(tokens, result.tokens);
    for (const model of result.models || []) models.add(String(model));
    skillItems.push(...(result.capabilities?.skills?.items || []));
    mcpServers.push(...(result.capabilities?.mcp?.servers || []));
  }
  return {
    tokens,
    models: [...models],
    capabilities: normalizeCapabilityUsage({ skills: { items: skillItems }, mcp: { servers: mcpServers } })
  };
}

function parseTranscriptFileWithSubagents(provider, transcriptPath) {
  const mainResult = parseTranscriptFile(provider, transcriptPath);
  if (provider !== "codebuddy") return mainResult;
  const results = [mainResult];
  for (const file of listCodeBuddySubagentFiles(transcriptPath)) {
    try { results.push(parseTranscriptFile(provider, file)); } catch { /* 子 agent transcript 可能还没有 usage 行 */ }
  }
  return results.length === 1 ? mainResult : mergeTranscriptResults(results);
}

module.exports = {
  TOKEN_FIELDS,
  addTokens,
  cloneTokens,
  createIncrementalTranscriptParser,
  emptyCapabilityUsage,
  emptyTokens,
  getCodeBuddySubagentsDir,
  listCodeBuddySubagentFiles,
  mergeTranscriptResults,
  normalizeClaudeUsage,
  normalizeCodeBuddyUsage,
  normalizeQoderTokenUsage,
  normalizeGeminiUsage,
  normalizeCapabilityUsage,
  normalizeCodexUsage,
  parseTranscriptFile,
  parseTranscriptFileWithSubagents,
  parseTranscriptText,
  safeInteger
};
