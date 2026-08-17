import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { parseTranscriptText } = require("./agent-token-transcript.cjs");

describe("agent token transcript parser", () => {
  it("reads the latest cumulative Codex token event", () => {
    const result = parseTranscriptText("codex", [
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } } }),
      "not-json",
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 180, cached_input_tokens: 80, output_tokens: 30, reasoning_output_tokens: 8, total_tokens: 210 } } } })
    ].join("\n"));
    expect(result.tokens).toMatchObject({ inputTokens: 180, cachedInputTokens: 80, outputTokens: 30, reasoningOutputTokens: 8, totalTokens: 210 });
  });

  it("deduplicates Claude message fragments and includes cache tokens", () => {
    const usage = { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5 };
    const result = parseTranscriptText("claude", [
      JSON.stringify({ type: "assistant", isSidechain: false, message: { id: "a", model: "claude-sonnet", usage } }),
      JSON.stringify({ type: "assistant", isSidechain: false, message: { id: "a", model: "claude-sonnet", usage } }),
      JSON.stringify({ type: "assistant", isSidechain: true, message: { id: "side", usage: { input_tokens: 999, output_tokens: 999 } } }),
      JSON.stringify({ type: "assistant", isSidechain: false, message: { id: "b", usage: { input_tokens: 4, output_tokens: 6 } } })
    ].join("\n"));
    expect(result.tokens).toEqual({ inputTokens: 64, cachedInputTokens: 30, cacheWriteInputTokens: 20, outputTokens: 11, reasoningOutputTokens: 0, totalTokens: 75 });
    expect(result.models).toEqual(["claude-sonnet"]);
  });
});
