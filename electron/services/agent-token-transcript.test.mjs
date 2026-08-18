import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createIncrementalTranscriptParser, parseTranscriptText } = require("./agent-token-transcript.cjs");

describe("agent token transcript parser", () => {
  it("reads the latest cumulative Codex token event", () => {
    const result = parseTranscriptText("codex", [
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } } }),
      "not-json",
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 180, cached_input_tokens: 80, output_tokens: 30, reasoning_output_tokens: 8, total_tokens: 210 } } } })
    ].join("\n"));
    expect(result.tokens).toMatchObject({ inputTokens: 180, cachedInputTokens: 80, outputTokens: 30, reasoningOutputTokens: 8, totalTokens: 210 });
  });

  it("counts nested Codex MCP calls and conservative skill entrypoint reads", () => {
    const result = parseTranscriptText("codex", [
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "one", name: "exec", input: "const a = await tools.mcp__logView__search_logs({}); const b = await tools.mcp__logView__tail_log({});" } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "two", name: "exec", input: "Get-Content C:\\\\Users\\\\me\\\\.codex\\\\skills\\\\diagnosing-bugs\\\\SKILL.md" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", content: "mcp__fake__mentioned and skills/fake/SKILL.md" } })
    ].join("\n"));

    expect(result.capabilities.skills).toMatchObject({ availability: "available", totalCalls: 1, items: [{ name: "diagnosing-bugs", count: 1 }] });
    expect(result.capabilities.mcp).toMatchObject({
      availability: "available",
      totalCalls: 2,
      servers: [{ name: "logView", count: 2, tools: [{ name: "search_logs", count: 1 }, { name: "tail_log", count: 1 }] }]
    });
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

  it("deduplicates Claude tool-use fragments and recognizes native skills", () => {
    const message = {
      id: "claude-a",
      usage: { input_tokens: 3, output_tokens: 2 },
      content: [
        { type: "tool_use", id: "tool-a", name: "mcp__jira__get_issue", input: {} },
        { type: "tool_use", id: "tool-b", name: "Skill", input: { skill: "code-review" } }
      ]
    };
    const result = parseTranscriptText("claude", [
      JSON.stringify({ type: "assistant", uuid: "row-a", message }),
      JSON.stringify({ type: "assistant", uuid: "row-b", message })
    ].join("\n"));

    expect(result.capabilities.skills.items).toEqual([{ name: "code-review", count: 1 }]);
    expect(result.capabilities.mcp.servers[0]).toMatchObject({ name: "jira", count: 1, tools: [{ name: "get_issue", count: 1 }] });
  });

  it("deduplicates CodeBuddy response fragments and reads cached and reasoning tokens", () => {
    const usage = {
      requests: 1,
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      inputTokensDetails: [{ cached_tokens: 80 }],
      outputTokensDetails: [{ reasoning_tokens: 12 }]
    };
    const result = parseTranscriptText("codebuddy", [
      JSON.stringify({ type: "reasoning", providerData: { messageId: "response-a", model: "glm-5.2", usage } }),
      JSON.stringify({ type: "function_call", providerData: { messageId: "response-a", model: "glm-5.2", usage } }),
      JSON.stringify({ type: "message", role: "assistant", providerData: { messageId: "response-b", model: "glm-5.2", rawUsage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 2 } } } })
    ].join("\n"));

    expect(result.tokens).toEqual({ inputTokens: 140, cachedInputTokens: 90, cacheWriteInputTokens: 0, outputTokens: 35, reasoningOutputTokens: 14, totalTokens: 175 });
    expect(result.models).toEqual(["glm-5.2"]);
  });

  it("updates an incremental CodeBuddy message instead of double counting it", () => {
    const parser = createIncrementalTranscriptParser("codebuddy");
    parser.pushLine(JSON.stringify({ providerData: { messageId: "response-a", model: "glm-5.2", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } } }));
    parser.pushLine("incomplete-json");
    parser.pushLine(JSON.stringify({ providerData: { messageId: "response-a", model: "glm-5.2", usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 } } }));
    parser.pushLine(JSON.stringify({ providerData: { messageId: "response-b", model: "glm-5.2", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } } }));

    expect(parser.getResult()).toMatchObject({
      tokens: { inputTokens: 120, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 0, totalTokens: 150 },
      models: ["glm-5.2"]
    });
  });

  it("counts repeated anonymous CodeBuddy MCP calls as separate executions", () => {
    const result = parseTranscriptText("codebuddy", [
      JSON.stringify({ type: "function_call", name: "mcp__database__query", input: { sql: "select 1" } }),
      JSON.stringify({ type: "function_call", name: "mcp__database__query", input: { sql: "select 1" } })
    ].join("\n"));
    expect(result.capabilities.mcp).toMatchObject({
      totalCalls: 2,
      servers: [{ name: "database", count: 2, tools: [{ name: "query", count: 2 }] }]
    });
  });

  it("keeps the latest cumulative Codex usage when parsing incrementally", () => {
    const parser = createIncrementalTranscriptParser("codex");
    parser.pushLine(JSON.stringify({ type: "session_meta", payload: { model: "gpt-5.6" } }));
    parser.pushLine(JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10, output_tokens: 2 } } } }));
    parser.pushLine(JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 20, output_tokens: 7 } } } }));

    expect(parser.getResult()).toMatchObject({
      tokens: { inputTokens: 20, outputTokens: 7, totalTokens: 27 },
      models: ["gpt-5.6"]
    });
  });
});
