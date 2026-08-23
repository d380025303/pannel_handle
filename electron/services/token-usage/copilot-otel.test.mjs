import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createCopilotOtelParser, getCopilotOtelPath } = require("./copilot-otel.cjs");

function chatSpan(overrides = {}) {
  const attributes = {
    "gen_ai.operation.name": "chat",
    "gen_ai.usage.input_tokens": 120,
    "gen_ai.usage.output_tokens": 30,
    "gen_ai.usage.cache_read.input_tokens": 10,
    "gen_ai.usage.cache_creation.input_tokens": 4,
    "gen_ai.response.model": "gpt-5",
    "gen_ai.conversation.id": "conversation-1",
    ...overrides
  };
  return {
    resourceSpans: [{
      scopeSpans: [{
        spans: [{
          traceId: "trace-1",
          spanId: "span-1",
          attributes: Object.entries(attributes).map(([key, value]) => ({
            key,
            value: Number.isInteger(value) ? { intValue: String(value) } : { stringValue: value }
          }))
        }]
      }]
    }]
  };
}

describe("copilot-otel", () => {
  it("aggregates official chat token attributes without content", () => {
    const parser = createCopilotOtelParser();

    expect(parser.pushLine(JSON.stringify(chatSpan()))).toBe(true);
    expect(parser.getResult()).toEqual(expect.objectContaining({
      agentSessionId: "conversation-1",
      models: ["gpt-5"],
      tokens: expect.objectContaining({
        inputTokens: 120,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 4,
        outputTokens: 30,
        totalTokens: 150
      }),
      capabilities: {
        skills: expect.objectContaining({ availability: "unavailable" }),
        mcp: expect.objectContaining({ availability: "unavailable" })
      }
    }));
  });

  it("ignores malformed, non-chat, and duplicate spans", () => {
    const parser = createCopilotOtelParser();

    expect(parser.pushLine("not-json")).toBe(false);
    expect(parser.pushLine(JSON.stringify(chatSpan({ "gen_ai.operation.name": "tool" })))).toBe(false);
    expect(parser.pushLine(JSON.stringify(chatSpan()))).toBe(true);
    expect(parser.pushLine(JSON.stringify(chatSpan()))).toBe(false);
    expect(parser.getResult().tokens.totalTokens).toBe(150);
  });

  it("uses an isolated platform path per panel session", () => {
    expect(getCopilotOtelPath({ id: "run:1", type: "wsl" })).toBe(`/tmp/pannel-handle-copilot-${process.pid}-run_1.otel.jsonl`);
    expect(getCopilotOtelPath({ id: "run:1", type: "windows" })).toMatch(new RegExp(`pannel-handle-copilot-${process.pid}-run_1\\.otel\\.jsonl$`));
  });
});
