const os = require("node:os");
const path = require("node:path");
const { emptyCapabilityUsage, emptyTokens, safeInteger } = require("./agent-token-transcript.cjs");

function getCopilotOtelPath(session) {
  const fileName = `pannel-handle-copilot-${process.pid}-${String(session?.id || "unknown").replace(/[^A-Za-z0-9_-]/g, "_")}.otel.jsonl`;
  return session?.type === "wsl" ? `/tmp/${fileName}` : path.join(os.tmpdir(), fileName);
}

function attributeValue(value) {
  if (!value || typeof value !== "object") return value;
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue"]) {
    if (value[key] !== undefined) return value[key];
  }
  return undefined;
}

function attributesToObject(attributes) {
  return Object.fromEntries((attributes || []).map(item => [item?.key, attributeValue(item?.value)]).filter(([key]) => key));
}

function spansFromPayload(payload) {
  const spans = [];
  for (const resource of payload?.resourceSpans || []) {
    const resourceAttributes = attributesToObject(resource?.resource?.attributes);
    for (const scope of resource?.scopeSpans || resource?.instrumentationLibrarySpans || []) {
      for (const span of scope?.spans || []) spans.push({ span, resourceAttributes });
    }
  }
  if (payload?.span && typeof payload.span === "object") spans.push({ span: payload.span, resourceAttributes: attributesToObject(payload.resource?.attributes) });
  return spans;
}

function createCopilotOtelParser() {
  const seen = new Set();
  const tokens = emptyTokens();
  const models = new Set();
  let agentSessionId = "";

  function pushLine(line) {
    let payload;
    try {
      payload = JSON.parse(String(line || ""));
    } catch {
      return false;
    }
    let changed = false;
    for (const { span, resourceAttributes } of spansFromPayload(payload)) {
      const attributes = { ...resourceAttributes, ...attributesToObject(span?.attributes) };
      if (attributes["gen_ai.operation.name"] !== "chat") continue;
      const spanKey = `${span?.traceId || span?.trace_id || ""}:${span?.spanId || span?.span_id || ""}`;
      if (spanKey === ":" || seen.has(spanKey)) continue;
      seen.add(spanKey);
      const input = safeInteger(attributes["gen_ai.usage.input_tokens"]);
      const output = safeInteger(attributes["gen_ai.usage.output_tokens"]);
      tokens.inputTokens += input;
      tokens.cachedInputTokens += safeInteger(attributes["gen_ai.usage.cache_read.input_tokens"]);
      tokens.cacheWriteInputTokens += safeInteger(attributes["gen_ai.usage.cache_creation.input_tokens"]);
      tokens.outputTokens += output;
      tokens.reasoningOutputTokens += safeInteger(attributes["gen_ai.usage.reasoning_tokens"]);
      tokens.totalTokens += input + output;
      const model = attributes["gen_ai.response.model"] || attributes["gen_ai.request.model"];
      if (model) models.add(String(model));
      agentSessionId ||= String(attributes["gen_ai.conversation.id"] || "");
      changed = true;
    }
    return changed;
  }

  function getResult() {
    if (!tokens.totalTokens) return null;
    return {
      agentSessionId,
      tokens: { ...tokens },
      models: [...models],
      capabilities: emptyCapabilityUsage("unavailable")
    };
  }

  return { pushLine, getResult };
}

module.exports = { createCopilotOtelParser, getCopilotOtelPath };
