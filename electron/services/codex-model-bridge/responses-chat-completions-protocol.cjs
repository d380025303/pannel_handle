const crypto = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");

const MAX_STREAM_LINE_BYTES = 16 * 1024 * 1024;

function invalidRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function textFromContent(content, { strict = false } = {}) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const values = [];
  for (const item of content) {
    if (typeof item === "string") {
      values.push(item);
      continue;
    }
    if (["input_text", "output_text", "text"].includes(item?.type)) {
      values.push(String(item.text || ""));
      continue;
    }
    if (strict) throw invalidRequest(`Responses content type is not supported by the Chat Completions bridge: ${String(item?.type || "unknown")}.`);
  }
  return values.filter(Boolean).join("\n");
}

function parseCustomArguments(value) {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed?.input === "string" ? parsed.input : value;
  } catch {
    return value;
  }
}

function toolIdentity(name, namespace = "") {
  return JSON.stringify([namespace, String(name || "").trim()]);
}

function toolAlias(name) {
  return `pht_${crypto.createHash("sha256").update(String(name)).digest("hex").slice(0, 12)}`;
}

function validateResponsesRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidRequest("Responses request body must be a JSON object.");
  if (body.stream === false) throw invalidRequest("The Chat Completions bridge requires stream=true.");
  if (body.store === true) throw invalidRequest("The Chat Completions bridge does not support stored Responses.");
  if (body.previous_response_id) throw invalidRequest("The Chat Completions bridge does not support previous_response_id; send the complete input history instead.");
  if (body.conversation) throw invalidRequest("The Chat Completions bridge does not support Responses conversations.");
  if (body.background === true) throw invalidRequest("The Chat Completions bridge does not support background Responses.");
}

function responsesToChat(body = {}, { ignoredToolTypes = [] } = {}) {
  validateResponsesRequest(body);
  const ignoredToolTypeSet = new Set(ignoredToolTypes.map(type => String(type)));
  const messages = [];
  const customTools = new Set();
  const toolAliases = new Map();
  const toolKinds = new Map();
  const toolNamespaces = new Map();
  const aliasesByToolIdentity = new Map();
  const identitiesByAlias = new Map();
  const deferredTools = [];
  const aliasFor = (name, kind = "function", namespace = "") => {
    const toolName = String(name || "").trim();
    if (!toolName) throw invalidRequest("Codex tool name is required.");
    const identity = toolIdentity(toolName, namespace);
    const alias = toolAlias(identity);
    const existing = identitiesByAlias.get(alias);
    if (existing && existing !== identity) throw invalidRequest(`Codex tool alias collision: ${toolName}.`);
    toolAliases.set(alias, toolName);
    toolKinds.set(alias, kind);
    if (namespace) toolNamespaces.set(alias, { namespace, name: toolName });
    identitiesByAlias.set(alias, identity);
    aliasesByToolIdentity.set(identity, alias);
    return alias;
  };
  const appendAssistantToolCall = toolCall => {
    const previous = messages.at(-1);
    if (previous?.role === "assistant" && previous.content === null && Array.isArray(previous.tool_calls)) {
      previous.tool_calls.push(toolCall);
      return;
    }
    messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
  };

  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
  const input = Array.isArray(body.input) ? body.input : [{ role: "user", content: body.input }];
  for (const item of input) {
    if (!item) continue;
    if (item.type === "message" || item.role) {
      const role = item.role === "developer" ? "system" : item.role || "user";
      if (!["system", "user", "assistant"].includes(role)) throw invalidRequest(`Responses message role is not supported: ${role}.`);
      messages.push({ role, content: textFromContent(item.content, { strict: true }) });
    } else if (item.type === "function_call") {
      appendAssistantToolCall({ id: item.call_id || item.id, type: "function", function: { name: aliasFor(item.name, "function", item.namespace), arguments: item.arguments || "{}" } });
    } else if (item.type === "custom_tool_call") {
      customTools.add(toolIdentity(item.name, item.namespace));
      appendAssistantToolCall({ id: item.call_id || item.id, type: "function", function: { name: aliasFor(item.name, "custom", item.namespace), arguments: JSON.stringify({ input: item.input || "" }) } });
    } else if (item.type === "tool_search_call") {
      appendAssistantToolCall({ id: item.call_id || item.id, type: "function", function: { name: aliasFor("tool_search", "tool_search"), arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}) } });
    } else if (item.type === "tool_search_output") {
      deferredTools.push(...(Array.isArray(item.tools) ? item.tools : []));
      messages.push({ role: "tool", tool_call_id: item.call_id, content: JSON.stringify({ tools: Array.isArray(item.tools) ? item.tools : [] }) });
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: textFromContent(item.output, { strict: true }) || String(item.output || "") });
    } else if (item.type === "reasoning") {
      continue;
    } else {
      throw invalidRequest(`Responses input item is not supported by the Chat Completions bridge: ${String(item.type || "unknown")}.`);
    }
  }

  function convertTool(tool, namespace = "") {
    if (!tool || typeof tool !== "object") throw invalidRequest("Codex tool definition must be an object.");
    if (ignoredToolTypeSet.has(String(tool.type || ""))) return [];
    if (tool.type === "namespace") {
      const namespaceName = String(tool.name || "").trim();
      if (!namespaceName) throw invalidRequest("Codex tool namespace name is required.");
      return (Array.isArray(tool.tools) ? tool.tools : []).flatMap(nested => convertTool(nested, namespace ? `${namespace}__${namespaceName}` : namespaceName));
    }
    const name = String(tool.name || "").trim();
    const originalName = namespace ? `${namespace}__${name}` : name;
    if (tool.type === "function") {
      return [{ type: "function", function: { name: aliasFor(name, "function", namespace), description: `Codex tool ${originalName}. ${tool.description || ""}`.trim(), parameters: tool.parameters || {}, ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}) } }];
    }
    if (tool.type === "custom") {
      customTools.add(toolIdentity(name, namespace));
      return [{
        type: "function",
        function: {
          name: aliasFor(name, "custom", namespace),
          description: `Codex tool ${originalName}. ${tool.description || "Codex custom tool"}\nReturn the complete custom tool input in the input field.`,
          parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false }
        }
      }];
    }
    if (tool.type === "tool_search" && tool.execution === "client") {
      return [{
        type: "function",
        function: {
          name: aliasFor("tool_search", "tool_search"),
          description: tool.description || "Search deferred Codex tool metadata and load matching tools.",
          parameters: tool.parameters || { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }
        }
      }];
    }
    throw invalidRequest(`Responses tool type is not supported by the Chat Completions bridge: ${String(tool.type || "unknown")}.`);
  }

  const convertedToolNames = new Set();
  const tools = [...(Array.isArray(body.tools) ? body.tools : []), ...deferredTools]
    .flatMap(tool => convertTool(tool))
    .filter(tool => {
      const name = tool.function.name;
      if (convertedToolNames.has(name)) return false;
      convertedToolNames.add(name);
      return true;
    });

  let toolChoice = body.tool_choice;
  let selectedToolAlias;
  if (toolChoice && typeof toolChoice === "object" && toolChoice.name) {
    const qualifiedName = toolChoice.namespace ? `${toolChoice.namespace}__${toolChoice.name}` : String(toolChoice.name);
    const alias = aliasesByToolIdentity.get(toolIdentity(toolChoice.name, toolChoice.namespace));
    if (!alias) throw invalidRequest(`Codex tool_choice references an unavailable tool: ${qualifiedName}.`);
    selectedToolAlias = alias;
    toolChoice = "required";
  } else if (toolChoice?.type === "tool_search") {
    const alias = aliasesByToolIdentity.get(toolIdentity("tool_search"));
    if (!alias) throw invalidRequest("Codex tool_choice references an unavailable tool: tool_search.");
    selectedToolAlias = alias;
    toolChoice = "required";
  } else if (toolChoice && typeof toolChoice === "object") {
    throw invalidRequest(`Responses tool_choice is not supported by the Chat Completions bridge: ${String(toolChoice.type || "unknown")}.`);
  }
  const requestTools = selectedToolAlias ? tools.filter(tool => tool.function.name === selectedToolAlias) : tools;
  return {
    request: {
      model: body.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(requestTools.length ? { tools: requestTools, tool_choice: toolChoice || "auto", parallel_tool_calls: body.parallel_tool_calls !== false } : {}),
      ...(body.max_output_tokens ? { max_tokens: body.max_output_tokens } : {}),
      ...(body.reasoning?.effort ? { reasoning_effort: body.reasoning.effort } : {})
    },
    customTools,
    toolAliases,
    toolKinds,
    toolNamespaces
  };
}

function createResponseAccumulator({ model, customTools = new Set(), toolAliases = new Map(), toolKinds = new Map(), toolNamespaces = new Map(), requireDone = false, allowFinishReasonAsDone = false, emit = () => {} }) {
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const decoder = new StringDecoder("utf8");
  let lineBuffer = "";
  let lineBytes = 0;
  let text = "";
  let messageStarted = false;
  let usage;
  let failure;
  let sawDone = false;
  let finishReason;
  const toolCalls = new Map();

  function send(type, value) {
    emit({ type, ...value });
  }

  function start() {
    send("response.created", { response: { id: responseId, object: "response", created_at: createdAt, status: "in_progress", model, output: [] } });
  }

  function ensureMessage() {
    if (messageStarted) return;
    messageStarted = true;
    send("response.output_item.added", { output_index: 0, item: { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] } });
    send("response.content_part.added", { item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  }

  function consumePayload(payload) {
    if (payload === "[DONE]") {
      sawDone = true;
      return;
    }
    let chunk;
    try { chunk = JSON.parse(payload); } catch {
      failure = { code: "invalid_stream", message: "Chat Completions upstream returned invalid JSON in its stream." };
      return;
    }
    if (chunk.error) {
      failure = {
        code: String(chunk.error.code || chunk.error.type || "provider_error"),
        message: String(chunk.error.message || "Chat Completions upstream returned a stream error.").slice(0, 1000),
        ...(chunk.error.request_id ? { request_id: String(chunk.error.request_id).slice(0, 200) } : {})
      };
      return;
    }
    if (chunk.base_resp && Number(chunk.base_resp.status_code) !== 0) {
      failure = {
        code: String(chunk.base_resp.status_code || "provider_error"),
        message: String(chunk.base_resp.status_msg || "Chat Completions upstream returned a business error.").slice(0, 1000)
      };
      return;
    }
    const chunkFinishReason = chunk.choices?.[0]?.finish_reason;
    if (chunkFinishReason !== null && chunkFinishReason !== undefined && String(chunkFinishReason).trim()) {
      finishReason = String(chunkFinishReason).trim();
    }
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta || {};
    const content = typeof delta.content === "string" ? delta.content : "";
    if (content) {
      ensureMessage();
      text += content;
      send("response.output_text.delta", { item_id: messageId, output_index: 0, content_index: 0, delta: content });
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = Number.isInteger(call.index) ? call.index : toolCalls.size;
      const current = toolCalls.get(index) || { id: call.id || `call_${crypto.randomUUID().replace(/-/g, "")}`, name: "", arguments: "" };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.arguments += call.function.arguments;
      toolCalls.set(index, current);
    }
  }

  function appendLinePart(part) {
    lineBytes += Buffer.byteLength(part, "utf8");
    if (lineBytes > MAX_STREAM_LINE_BYTES) {
      failure = { code: "stream_line_too_large", message: "Chat Completions upstream returned a stream line larger than 16 MiB." };
      return false;
    }
    lineBuffer += part;
    return true;
  }

  function consumeText(value) {
    let start = 0;
    while (!failure && start < value.length) {
      const newline = value.indexOf("\n", start);
      if (newline === -1) {
        appendLinePart(value.slice(start));
        break;
      }
      if (!appendLinePart(value.slice(start, newline))) break;
      const line = lineBuffer.trimStart();
      if (line.startsWith("data:")) consumePayload(line.slice(5).trim());
      lineBuffer = "";
      lineBytes = 0;
      start = newline + 1;
    }
  }

  function push(chunk) {
    if (!failure) consumeText(decoder.write(chunk));
  }

  function responseUsage() {
    return usage ? {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
      input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0 },
      output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0 }
    } : undefined;
  }

  function finish() {
    if (!failure) consumeText(decoder.end());
    if (!failure && lineBuffer.trimStart().startsWith("data:")) consumePayload(lineBuffer.trimStart().slice(5).trim());
    if (!failure && requireDone && !sawDone && !(allowFinishReasonAsDone && finishReason)) {
      failure = { code: "incomplete_stream", message: "Chat Completions stream ended before [DONE]." };
    }
    if (failure) {
      const response = { id: responseId, object: "response", created_at: createdAt, status: "failed", model, output: [], error: failure };
      send("error", { error: failure });
      send("response.failed", { response });
      return response;
    }

    const status = finishReason === "length" ? "incomplete" : "completed";
    const output = [];
    let outputIndex = 0;
    if (messageStarted || text) {
      const item = { id: messageId, type: "message", status, role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
      send("response.output_text.done", { item_id: messageId, output_index: 0, content_index: 0, text });
      send("response.content_part.done", { item_id: messageId, output_index: 0, content_index: 0, part: item.content[0] });
      send("response.output_item.done", { output_index: 0, item });
      output.push(item);
      outputIndex = 1;
    }
    for (const call of [...toolCalls.values()]) {
      const originalName = toolAliases.get(call.name) || call.name;
      const toolKind = toolKinds.get(call.name);
      const namespaceEntry = toolNamespaces.get(call.name);
      const isCustom = toolKind
        ? toolKind === "custom"
        : customTools.has(toolIdentity(namespaceEntry?.name || originalName, namespaceEntry?.namespace)) || customTools.has(originalName);
      const item = toolKind === "tool_search"
        ? { id: `tsc_${crypto.randomUUID().replace(/-/g, "")}`, type: "tool_search_call", status, call_id: call.id, execution: "client", arguments: (() => { try { return JSON.parse(call.arguments || "{}"); } catch { return {}; } })() }
        : isCustom
        ? { id: `ctc_${crypto.randomUUID().replace(/-/g, "")}`, type: "custom_tool_call", status, call_id: call.id, name: namespaceEntry?.name || originalName, ...(namespaceEntry ? { namespace: namespaceEntry.namespace } : {}), input: parseCustomArguments(call.arguments) }
        : { id: `fc_${crypto.randomUUID().replace(/-/g, "")}`, type: "function_call", status, call_id: call.id, name: namespaceEntry?.name || originalName, ...(namespaceEntry ? { namespace: namespaceEntry.namespace } : {}), arguments: call.arguments || "{}" };
      send("response.output_item.added", { output_index: outputIndex, item: { ...item, status: "in_progress" } });
      send("response.output_item.done", { output_index: outputIndex, item });
      output.push(item);
      outputIndex += 1;
    }
    const normalizedUsage = responseUsage();
    const response = { id: responseId, object: "response", created_at: createdAt, status, model, output, ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}), ...(normalizedUsage ? { usage: normalizedUsage } : {}) };
    send(`response.${status}`, { response });
    return response;
  }

  function fail(error) {
    failure = {
      code: String(error?.code || error?.type || "provider_error"),
      message: String(error?.message || error || "Chat Completions upstream failed.").slice(0, 1000),
      ...(error?.request_id ? { request_id: String(error.request_id).slice(0, 200) } : {})
    };
  }

  return { start, push, finish, fail };
}

module.exports = { MAX_STREAM_LINE_BYTES, invalidRequest, validateResponsesRequest, responsesToChat, createResponseAccumulator, textFromContent, parseCustomArguments, toolAlias };
