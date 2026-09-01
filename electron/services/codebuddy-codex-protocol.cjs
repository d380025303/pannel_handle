const crypto = require("node:crypto");
const SUPPORTED_CODEX_TOOLS = new Set(["exec_command", "write_stdin", "apply_patch", "view_image"]);

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(item => {
    if (typeof item === "string") return item;
    if (["input_text", "output_text", "text"].includes(item?.type)) return String(item.text || "");
    return "";
  }).filter(Boolean).join("\n");
}

function parseCustomArguments(value) {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed?.input === "string" ? parsed.input : value;
  } catch {
    return value;
  }
}

function toolAlias(name) {
  return `pht_${crypto.createHash("sha256").update(String(name)).digest("hex").slice(0, 12)}`;
}

function responsesToChat(body = {}) {
  const messages = [];
  const customTools = new Set();
  const toolAliases = new Map();
  const aliasFor = name => {
    const alias = toolAlias(name);
    toolAliases.set(alias, name);
    return alias;
  };
  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
  const input = Array.isArray(body.input) ? body.input : [{ role: "user", content: body.input }];
  for (const item of input) {
    if (!item) continue;
    if (item.type === "message" || item.role) {
      messages.push({ role: item.role === "developer" ? "system" : item.role || "user", content: textFromContent(item.content) });
    } else if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: item.call_id || item.id, type: "function", function: { name: aliasFor(item.name), arguments: item.arguments || "{}" } }]
      });
    } else if (item.type === "custom_tool_call") {
      customTools.add(item.name);
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: item.call_id || item.id, type: "function", function: { name: aliasFor(item.name), arguments: JSON.stringify({ input: item.input || "" }) } }]
      });
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: textFromContent(item.output) || String(item.output || "") });
    }
  }

  const tools = (Array.isArray(body.tools) ? body.tools : []).map(tool => {
    if (!SUPPORTED_CODEX_TOOLS.has(tool.name) && !String(tool.name || "").startsWith("codex_probe")) return null;
    if (tool.type === "function") {
      return { type: "function", function: { name: aliasFor(tool.name), description: `Codex tool ${tool.name}. ${tool.description || ""}`.trim(), parameters: tool.parameters || {}, ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}) } };
    }
    if (tool.type === "custom") {
      customTools.add(tool.name);
      return {
        type: "function",
        function: {
          name: aliasFor(tool.name),
          description: `Codex tool ${tool.name}. ${tool.description || "Codex custom tool"}\nReturn the complete custom tool input in the input field.`,
          parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false }
        }
      };
    }
    return null;
  }).filter(Boolean);

  let toolChoice = body.tool_choice;
  if (toolChoice && typeof toolChoice === "object" && toolChoice.name) {
    toolChoice = "required";
  }
  return {
    request: {
      model: body.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.length ? { tools, tool_choice: toolChoice || "auto", parallel_tool_calls: body.parallel_tool_calls !== false } : {}),
      ...(body.max_output_tokens ? { max_tokens: body.max_output_tokens } : {}),
      ...(body.reasoning?.effort ? { reasoning_effort: body.reasoning.effort } : {})
    },
    customTools,
    toolAliases
  };
}

function createResponseAccumulator({ model, customTools = new Set(), toolAliases = new Map(), emit = () => {} }) {
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let lineBuffer = "";
  let text = "";
  let messageStarted = false;
  let usage;
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
    if (payload === "[DONE]") return;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { return; }
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

  function push(chunk) {
    lineBuffer += chunk.toString("utf-8");
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data:")) consumePayload(line.slice(5).trim());
    }
  }

  function finish() {
    if (lineBuffer.startsWith("data:")) consumePayload(lineBuffer.slice(5).trim());
    const output = [];
    let outputIndex = 0;
    if (messageStarted || text) {
      const item = { id: messageId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
      send("response.output_text.done", { item_id: messageId, output_index: 0, content_index: 0, text });
      send("response.content_part.done", { item_id: messageId, output_index: 0, content_index: 0, part: item.content[0] });
      send("response.output_item.done", { output_index: 0, item });
      output.push(item);
      outputIndex = 1;
    }
    for (const call of [...toolCalls.values()]) {
      const originalName = toolAliases.get(call.name) || call.name;
      const isCustom = customTools.has(originalName);
      const item = isCustom
        ? { id: `ctc_${crypto.randomUUID().replace(/-/g, "")}`, type: "custom_tool_call", status: "completed", call_id: call.id, name: originalName, input: parseCustomArguments(call.arguments) }
        : { id: `fc_${crypto.randomUUID().replace(/-/g, "")}`, type: "function_call", status: "completed", call_id: call.id, name: originalName, arguments: call.arguments || "{}" };
      send("response.output_item.added", { output_index: outputIndex, item: { ...item, status: "in_progress" } });
      send("response.output_item.done", { output_index: outputIndex, item });
      output.push(item);
      outputIndex += 1;
    }
    const responseUsage = usage ? {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
      input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0 },
      output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0 }
    } : undefined;
    const response = { id: responseId, object: "response", created_at: createdAt, status: "completed", model, output, ...(responseUsage ? { usage: responseUsage } : {}) };
    send("response.completed", { response });
    return response;
  }

  return { start, push, finish };
}

module.exports = { SUPPORTED_CODEX_TOOLS, responsesToChat, createResponseAccumulator, textFromContent, parseCustomArguments, toolAlias };
