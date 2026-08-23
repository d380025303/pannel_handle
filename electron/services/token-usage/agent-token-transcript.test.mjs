import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createIncrementalTranscriptParser, parseTranscriptText } = require("./agent-token-transcript.cjs");

describe("agent token transcript parser", () => {
  it("normalizes Gemini usage and applies message updates, checkpoints, and rewinds", () => {
    const result = parseTranscriptText("gemini", [
      JSON.stringify({ sessionId: "session-1", projectHash: "hash" }),
      JSON.stringify({ id: "a", type: "gemini", model: "gemini-2.5-pro", content: "draft", tokens: { input: 100, cached: 40, output: 20, thoughts: 5, total: 120 } }),
      JSON.stringify({ id: "a", type: "gemini", model: "gemini-2.5-pro", content: "updated", tokens: { input: 110, cached: 50, output: 30, thoughts: 8, total: 140 } }),
      JSON.stringify({ $set: { messages: [
        { id: "a", type: "gemini", model: "gemini-2.5-pro", content: "checkpoint", tokens: { input: 110, cached: 50, output: 30, thoughts: 8, total: 140 } },
        { id: "b", type: "gemini", model: "gemini-2.5-flash", content: "second", tokens: { input: 20, cached: 5, output: 4, total: 24 } }
      ] } }),
      JSON.stringify({ id: "c", type: "gemini", content: "rewound", tokens: { input: 999, output: 1, total: 1000 } }),
      JSON.stringify({ $rewindTo: "c" })
    ].join("\n"));
    expect(result.tokens).toEqual({ inputTokens: 75, cachedInputTokens: 55, cacheWriteInputTokens: 0, outputTokens: 34, reasoningOutputTokens: 8, totalTokens: 164 });
    expect(result.models).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);
  });

  it("reads legacy Gemini JSON conversations", () => {
    const result = parseTranscriptText("gemini", JSON.stringify({ messages: [
      { id: "legacy", type: "gemini", model: "gemini-2.0-flash", tokens: { input: 12, cached: 2, output: 3, total: 15 } }
    ] }, null, 2));
    expect(result.tokens).toMatchObject({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, totalTokens: 15 });
  });
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
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "two", output: "Script completed\nExit code: 0" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", content: "mcp__fake__mentioned and skills/fake/SKILL.md" } })
    ].join("\n"));

    expect(result.capabilities.skills).toMatchObject({ availability: "available", totalCalls: 1, items: [{ name: "diagnosing-bugs", count: 1 }] });
    expect(result.capabilities.mcp).toMatchObject({
      availability: "available",
      totalCalls: 2,
      servers: [{ name: "logView", count: 2, tools: [{ name: "search_logs", count: 1 }, { name: "tail_log", count: 1 }] }]
    });
  });

  it("counts each successfully loaded Codex skill once per session", () => {
    const result = parseTranscriptText("codex", [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<skill>\n<name>ktcrm-front-automation</name>\n<path>C:\\\\repo\\\\skills\\\\ktcrm-front-automation\\\\SKILL.md</path>\n</skill>" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "read-one", name: "exec", input: "Get-Content C:\\\\Users\\\\me\\\\.codex\\\\skills\\\\diagnosing-bugs\\\\SKILL.md" } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "read-one", output: "Script completed\nExit code: 0" } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "read-two", name: "exec", input: "Get-Content C:\\\\Users\\\\me\\\\.codex\\\\skills\\\\diagnosing-bugs\\\\SKILL.md | Select-Object -Skip 200" } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "read-two", output: "Script completed\nExit code: 0" } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "write", name: "exec", input: "const patch = '*** Add File: C:\\\\repo\\\\skills\\\\draft-skill\\\\SKILL.md'; await tools.apply_patch(patch);" } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "write", output: "Done!" } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "failed-read", name: "exec", input: "Get-Content C:\\\\Users\\\\me\\\\.codex\\\\skills\\\\missing-skill\\\\SKILL.md" } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "failed-read", output: "Script failed\nExit code: 1" } })
    ].join("\n"));

    expect(result.capabilities.skills).toEqual({
      availability: "available",
      totalCalls: 2,
      items: [
        { name: "diagnosing-bugs", count: 1 },
        { name: "ktcrm-front-automation", count: 1 }
      ]
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
        { type: "tool_use", id: "tool-b", name: "Skill", input: { skill: "code-review" } },
        { type: "tool_use", id: "tool-c", name: "Skill", input: { skill: "code-review" } }
      ]
    };
    const result = parseTranscriptText("claude", [
      JSON.stringify({ type: "assistant", uuid: "row-a", message }),
      JSON.stringify({ type: "assistant", uuid: "row-b", message })
    ].join("\n"));

    expect(result.capabilities.skills.items).toEqual([{ name: "code-review", count: 1 }]);
    expect(result.capabilities.mcp.servers[0]).toMatchObject({ name: "jira", count: 1, tools: [{ name: "get_issue", count: 1 }] });
  });

  it("deduplicates Qoder assistant messages and includes cached input tokens", () => {
    const message = {
      id: "qoder-a",
      model: "qoder-model",
      usage: { input_tokens: 30, cache_read_input_tokens: 70, cache_creation_input_tokens: 10, output_tokens: 20 },
      content: [
        { type: "tool_use", id: "tool-a", name: "mcp__jira__get_issue", input: {} },
        { type: "tool_use", id: "tool-b", name: "Skill", input: { skill: "code-review" } }
      ]
    };
    const result = parseTranscriptText("qoder", [
      JSON.stringify({ type: "assistant", uuid: "row-a", message }),
      JSON.stringify({ type: "assistant", uuid: "row-b", message }),
      JSON.stringify({ type: "assistant", uuid: "row-c", message: { id: "qoder-b", model: "qoder-model", usage: { input_tokens: 5, output_tokens: 3 }, content: [] } })
    ].join("\n"));

    expect(result.tokens).toEqual({ inputTokens: 115, cachedInputTokens: 70, cacheWriteInputTokens: 10, outputTokens: 23, reasoningOutputTokens: 0, totalTokens: 138 });
    expect(result.models).toEqual(["qoder-model"]);
    expect(result.capabilities.skills.items).toEqual([{ name: "code-review", count: 1 }]);
    expect(result.capabilities.mcp.servers[0]).toMatchObject({ name: "jira", count: 1, tools: [{ name: "get_issue", count: 1 }] });
  });

  it("falls back to Qoder credits when token fields are zeroed", () => {
    const result = parseTranscriptText("qoder", [
      JSON.stringify({ type: "assistant", uuid: "row-a", message: { id: "qoder-a", model: "auto", usage: { input_tokens: 0, output_tokens: 0, credits: 2.949214285714286 }, content: [] } }),
      JSON.stringify({ type: "assistant", uuid: "row-b", message: { id: "qoder-b", model: "auto", usage: { input_tokens: 0, output_tokens: 0, credits: 4.478249999999999 }, content: [] } }),
      JSON.stringify({ type: "assistant", uuid: "row-c", message: { id: "qoder-c", model: "auto", usage: { input_tokens: 0, output_tokens: 0, original_credits: 0.45120428571428567 }, content: [] } })
    ].join("\n"));

    expect(result.tokens).toEqual({ inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 7, reasoningOutputTokens: 0, totalTokens: 7 });
    expect(result.models).toEqual(["auto"]);
  });

  it("deduplicates Qwen Code messages and normalizes cache and reasoning usage", () => {
    const message = {
      id: "qwen-a",
      model: "qwen3-coder-plus",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 60,
        cache_creation_input_tokens: 5,
        output_tokens: 20,
        thoughts_token_count: 7,
        total_tokens: 120
      },
      content: [{ type: "tool_use", id: "tool-a", name: "mcp__jira__get_issue", input: {} }]
    };
    const result = parseTranscriptText("qwen", [
      JSON.stringify({ type: "assistant", uuid: "row-a", message }),
      JSON.stringify({ type: "assistant", uuid: "row-b", message }),
      JSON.stringify({ type: "assistant", uuid: "row-c", message: { id: "qwen-b", model: "qwen3-coder-plus", usage: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 }, parts: [] } })
    ].join("\n"));

    expect(result.tokens).toEqual({ inputTokens: 110, cachedInputTokens: 60, cacheWriteInputTokens: 5, outputTokens: 23, reasoningOutputTokens: 7, totalTokens: 133 });
    expect(result.models).toEqual(["qwen3-coder-plus"]);
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
