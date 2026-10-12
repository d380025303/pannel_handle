import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createIncrementalTranscriptParser, parseTranscriptFileWithSubagents, parseTranscriptText } = require("./agent-token-transcript.cjs");

describe("agent token transcript parser", () => {
  it("rejects transcripts from removed providers", () => {
    expect(() => parseTranscriptText("qwen", "{}"))
      .toThrow("Unsupported token statistics provider: qwen");
  });

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

  it.each([false, true])("rewinds Gemini usage to a user message (checkpoint: %s)", (checkpoint) => {
    const messages = [
      { id: "u1", type: "user", content: "first prompt" },
      { id: "a1", type: "gemini", tokens: { input: 10, output: 5, total: 15 } },
      { id: "u2", type: "user", content: "second prompt" },
      { id: "a2", type: "gemini", tokens: { input: 20, output: 10, total: 30 } }
    ];
    const lines = (checkpoint ? [{ $set: { messages } }] : messages).map((record) => JSON.stringify(record));
    const parser = createIncrementalTranscriptParser("gemini");
    for (const line of lines) parser.pushLine(line);
    expect(parser.getResult().tokens.totalTokens).toBe(45);

    const rewind = JSON.stringify({ $rewindTo: "u2" });
    parser.pushLine(rewind);
    const expectedTokens = { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 };
    expect(parser.getResult().tokens).toEqual(expectedTokens);
    expect(parseTranscriptText("gemini", [...lines, rewind].join("\n")).tokens).toEqual(expectedTokens);
  });

  it("reads legacy Gemini JSON conversations", () => {
    const result = parseTranscriptText("gemini", JSON.stringify({ messages: [
      { id: "legacy", type: "gemini", model: "gemini-2.0-flash", tokens: { input: 12, cached: 2, output: 3, total: 15 } }
    ] }, null, 2));
    expect(result.tokens).toMatchObject({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, totalTokens: 15 });
  });

  it("sums Grok per-turn usage and deduplicates Grok tool updates", () => {
    const turn = (promptId, usage) => JSON.stringify({
      timestamp: 1,
      params: { _meta: { promptId }, update: { sessionUpdate: "turn_completed", usage } }
    });
    const tool = (eventId, namespace, name) => JSON.stringify({
      timestamp: 2,
      params: {
        _meta: { eventId },
        update: {
          sessionUpdate: "tool_call",
          toolCallId: eventId,
          _meta: { "x.ai/tool": { namespace, name, kind: "execute" } },
          rawInput: { value: 1 }
        }
      }
    });
    const result = parseTranscriptText("grok", [
      turn("one", { inputTokens: 10, cachedReadTokens: 20, outputTokens: 5, reasoningTokens: 2, totalTokens: 35, modelUsage: { "grok-build": {} } }),
      turn("two", { inputTokens: 7, cachedReadTokens: 3, outputTokens: 4, reasoningTokens: 1, totalTokens: 14, modelUsage: { "grok-build": {} } }),
      tool("tool-one", "jira", "get_issue"),
      tool("tool-one", "jira", "get_issue")
    ].join("\n"));

    expect(result.tokens).toEqual({ inputTokens: 17, cachedInputTokens: 23, cacheWriteInputTokens: 0, outputTokens: 9, reasoningOutputTokens: 3, totalTokens: 49 });
    expect(result.models).toEqual(["grok-build"]);
    expect(result.capabilities.mcp).toMatchObject({ totalCalls: 1, servers: [{ name: "jira", count: 1, tools: [{ name: "get_issue", count: 1 }] }] });
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

  it("aggregates CodeBuddy subagent transcripts with the main transcript", async () => {
    const tempDirectory = await mkdtemp(nodePath.join(tmpdir(), "pannel-handle-cb-aggregate-"));
    try {
      const transcriptPath = nodePath.join(tempDirectory, "session-a.jsonl");
      const subagentsDir = nodePath.join(tempDirectory, "session-a", "subagents");
      await mkdir(subagentsDir, { recursive: true });
      await writeFile(transcriptPath, [
        JSON.stringify({ type: "function_call", name: "mcp__database__query", input: { sql: "select 1" } }),
        JSON.stringify({ type: "message", providerData: { messageId: "m1", model: "glm-5.2", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } })
      ].join("\n"), "utf-8");
      await writeFile(nodePath.join(subagentsDir, "agent-one.jsonl"), [
        JSON.stringify({ type: "function_call", name: "mcp__database__query", input: { sql: "select 1" } }),
        JSON.stringify({ type: "message", providerData: { messageId: "s1", model: "glm-5.2", usage: { inputTokens: 500, outputTokens: 40, totalTokens: 540 } } })
      ].join("\n"), "utf-8");
      await writeFile(nodePath.join(subagentsDir, "agent-two.jsonl"), [
        JSON.stringify({ type: "message", providerData: { messageId: "s2", model: "glm-5.2-lite", usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 } } })
      ].join("\n"), "utf-8");
      await writeFile(nodePath.join(subagentsDir, "pending.jsonl"), "not-usage-yet\n", "utf-8");

      const result = parseTranscriptFileWithSubagents("codebuddy", transcriptPath);
      expect(result.tokens).toMatchObject({ inputTokens: 630, outputTokens: 70, totalTokens: 700 });
      expect(result.models).toEqual(["glm-5.2", "glm-5.2-lite"]);
      expect(result.capabilities.mcp).toMatchObject({ totalCalls: 2, servers: [{ name: "database", count: 2, tools: [{ name: "query", count: 2 }] }] });

      const soloPath = nodePath.join(tempDirectory, "session-b.jsonl");
      await writeFile(soloPath, JSON.stringify({ type: "message", providerData: { messageId: "m1", model: "glm-5.2", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } }), "utf-8");
      expect(parseTranscriptFileWithSubagents("codebuddy", soloPath).tokens).toMatchObject({ totalTokens: 12 });

      const codexPath = nodePath.join(tempDirectory, "session-c.jsonl");
      const codexSubagentsDir = nodePath.join(tempDirectory, "session-c", "subagents");
      await mkdir(codexSubagentsDir, { recursive: true });
      await writeFile(codexPath, JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } } }), "utf-8");
      await writeFile(nodePath.join(codexSubagentsDir, "agent.jsonl"), JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 999, output_tokens: 999, total_tokens: 1998 } } } }), "utf-8");
      expect(parseTranscriptFileWithSubagents("codex", codexPath).tokens).toMatchObject({ totalTokens: 10 });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
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
