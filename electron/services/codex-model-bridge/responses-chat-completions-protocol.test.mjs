import { describe, expect, it } from "vitest";
import protocol from "./responses-chat-completions-protocol.cjs";

const { responsesToChat, createResponseAccumulator } = protocol;

describe("Responses to Chat Completions protocol", () => {
  it("converts Responses messages and custom tools to Chat Completions", () => {
    const result = responsesToChat({ model: "glm-5.3", instructions: "system", input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "custom_tool_call", call_id: "call-1", name: "apply_patch", input: "*** Begin Patch" },
      { type: "custom_tool_call_output", call_id: "call-1", output: "Done" }
    ], tools: [{ type: "custom", name: "apply_patch", description: "Patch files", format: { type: "text" } }] });
    expect(result.request.messages[0]).toEqual({ role: "system", content: "system" });
    expect(result.request.messages[2].tool_calls[0].function.arguments).toBe(JSON.stringify({ input: "*** Begin Patch" }));
    expect(result.request.messages[2].tool_calls[0].function.name).toMatch(/^pht_/);
    expect(result.request.messages[3]).toEqual({ role: "tool", tool_call_id: "call-1", content: "Done" });
    expect(result.request.tools[0].function.parameters.required).toEqual(["input"]);
    expect(result.customTools.has("apply_patch")).toBe(true);
  });

  it("normalizes developer messages and forwards built-in and MCP function tools", () => {
    const result = responsesToChat({ input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "follow repository rules" }] }
    ], tools: [
      { type: "function", name: "exec_command", description: "Run a command", parameters: { type: "object" } },
      { type: "function", name: "mcp__jira__get_issue", description: "Read a Jira issue", parameters: { type: "object" } }
    ], tool_choice: { type: "function", name: "mcp__jira__get_issue" } });
    expect(result.request.messages[0]).toEqual({ role: "system", content: "follow repository rules" });
    expect(result.request.tools).toHaveLength(1);
    expect([...result.toolAliases.values()]).toEqual(["exec_command", "mcp__jira__get_issue"]);
    const mcpAlias = [...result.toolAliases].find(([, name]) => name === "mcp__jira__get_issue")[0];
    expect(result.request.tools[0].function.name).toBe(mcpAlias);
    expect(result.request.tool_choice).toBe("required");
  });

  it("serializes a selected custom tool with CodeBuddy's string tool choice", () => {
    const result = responsesToChat({
      tools: [
        { type: "custom", name: "apply_patch" },
        { type: "custom", name: "view_image" }
      ],
      tool_choice: { type: "custom", name: "view_image" }
    });
    expect(result.request.tools).toHaveLength(1);
    expect(result.toolAliases.get(result.request.tools[0].function.name)).toBe("view_image");
    expect(result.request.tool_choice).toBe("required");
  });

  it("groups consecutive Responses calls into one parallel Chat Completions assistant turn", () => {
    const result = responsesToChat({ input: [
      { type: "function_call", call_id: "call-1", name: "first", arguments: "{}" },
      { type: "function_call", call_id: "call-2", name: "second", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: "one" },
      { type: "function_call_output", call_id: "call-2", output: "two" }
    ], tools: [
      { type: "function", name: "first", parameters: { type: "object" } },
      { type: "function", name: "second", parameters: { type: "object" } }
    ] });
    expect(result.request.messages[0].tool_calls).toHaveLength(2);
    expect(result.request.messages.slice(1)).toEqual([
      { role: "tool", tool_call_id: "call-1", content: "one" },
      { role: "tool", tool_call_id: "call-2", content: "two" }
    ]);
  });

  it("rejects provider-hosted tools and unavailable forced tools instead of silently degrading", () => {
    expect(() => responsesToChat({ tools: [{ type: "web_search", external_web_access: true }] })).toThrow("tool type is not supported");
    expect(() => responsesToChat({ tools: [{ type: "function", name: "exec_command" }], tool_choice: { type: "function", name: "missing" } })).toThrow("tool_choice references an unavailable tool");
  });

  it("rejects stateful, non-streaming, and non-text Responses features", () => {
    expect(() => responsesToChat({ stream: false, input: "hello" })).toThrow("requires stream=true");
    expect(() => responsesToChat({ store: true, input: "hello" })).toThrow("stored Responses");
    expect(() => responsesToChat({ previous_response_id: "resp_old", input: "hello" })).toThrow("complete input history");
    expect(() => responsesToChat({ input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }] })).toThrow("content type is not supported");
  });

  it("bridges client tool search so Codex can discover deferred MCP tools", () => {
    const converted = responsesToChat({
      tools: [{ type: "tool_search", execution: "client", description: "Find deferred tools", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
      tool_choice: { type: "tool_search" }
    });
    const alias = converted.request.tools[0].function.name;
    expect(converted.request.tool_choice).toBe("required");

    const events = [];
    const accumulator = createResponseAccumulator({ model: "glm-5.3", toolAliases: converted.toolAliases, toolKinds: converted.toolKinds, emit: event => events.push(event) });
    accumulator.start();
    accumulator.push(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "search-1", function: { name: alias, arguments: '{"query":"jira issue"}' } }] } }] })}\n\n`));
    const response = accumulator.finish();
    expect(response.output[0]).toMatchObject({ type: "tool_search_call", call_id: "search-1", execution: "client", arguments: { query: "jira issue" } });
    expect(events.at(-1).type).toBe("response.completed");

    const followUp = responsesToChat({ input: [
      response.output[0],
      { type: "tool_search_output", call_id: "search-1", execution: "client", tools: [{ type: "namespace", name: "mcp__jira", tools: [{ type: "function", name: "get_issue", description: "Read an issue", parameters: { type: "object" } }] }] }
    ] });
    expect(followUp.request.messages[0].tool_calls[0].function.name).toBeTruthy();
    expect(followUp.request.messages[1]).toEqual({ role: "tool", tool_call_id: "search-1", content: JSON.stringify({ tools: [{ type: "namespace", name: "mcp__jira", tools: [{ type: "function", name: "get_issue", description: "Read an issue", parameters: { type: "object" } }] }] }) });
    expect(followUp.request.tools).toHaveLength(1);
    expect([...followUp.toolAliases.values()]).toContain("mcp__jira__get_issue");

    const mcpAlias = [...followUp.toolAliases].find(([, name]) => name === "mcp__jira__get_issue")[0];
    const mcpAccumulator = createResponseAccumulator({ model: "glm-5.3", toolAliases: followUp.toolAliases, toolKinds: followUp.toolKinds, toolNamespaces: followUp.toolNamespaces });
    mcpAccumulator.start();
    mcpAccumulator.push(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "mcp-1", function: { name: mcpAlias, arguments: "{}" } }] } }] })}\n\n`));
    expect(mcpAccumulator.finish().output[0]).toMatchObject({ type: "function_call", call_id: "mcp-1", namespace: "mcp__jira", name: "get_issue" });
  });

  it("streams text and restores custom tool calls as Responses events", () => {
    const events = [];
    const alias = responsesToChat({ tools: [{ type: "custom", name: "apply_patch" }] });
    const aliasedName = [...alias.toolAliases.keys()][0];
    const parser = createResponseAccumulator({ model: "glm-5.3", customTools: new Set(["apply_patch"]), toolAliases: alias.toolAliases, emit: event => events.push(event) });
    parser.start();
    const wire = [
      { choices: [{ delta: { content: "你" } }] },
      { choices: [{ delta: { content: "好", tool_calls: [{ index: 0, id: "call-1", function: { name: aliasedName, arguments: '{"input":"*** Begin' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' Patch"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("");
    const bytes = Buffer.from(wire);
    parser.push(bytes.subarray(0, 17));
    parser.push(bytes.subarray(17));
    const response = parser.finish();
    expect(response.output[0].content[0].text).toBe("你好");
    expect(response.output[1]).toMatchObject({ type: "custom_tool_call", call_id: "call-1", name: "apply_patch", input: "*** Begin Patch" });
    expect(response.usage.total_tokens).toBe(14);
    expect(events.at(-1).type).toBe("response.completed");
  });

  it("turns Chat Completions stream failures and truncated streams into Responses failures", () => {
    const errors = [];
    const failed = createResponseAccumulator({ model: "glm-5.3", requireDone: true, emit: event => errors.push(event) });
    failed.start();
    failed.push(Buffer.from('data: {"error":{"type":"rate_limit","message":"quota reached","request_id":"req-1"}}\n\ndata: [DONE]\n\n'));
    expect(failed.finish()).toMatchObject({ status: "failed", error: { code: "rate_limit", message: "quota reached", request_id: "req-1" } });
    expect(errors.at(-1).type).toBe("response.failed");

    const truncated = createResponseAccumulator({ model: "glm-5.3", requireDone: true });
    truncated.start();
    truncated.push(Buffer.from('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
    expect(truncated.finish()).toMatchObject({ status: "failed", error: { code: "incomplete_stream" } });
  });

  it.each([
    ["stop", { content: "complete" }],
    ["tool_calls", { tool_calls: [{ index: 0, id: "call-1", function: { name: "echo", arguments: "{}" } }] }]
  ])("accepts finish_reason %s as an opt-in terminal signal", (finishReason, delta) => {
    const parser = createResponseAccumulator({ model: "MiniMax-M3", requireDone: true, allowFinishReasonAsDone: true });
    parser.start();
    parser.push(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`));

    expect(parser.finish()).toMatchObject({ status: "completed" });
  });

  it("keeps finish_reason opt-in and still rejects streams without a terminal signal", () => {
    const strict = createResponseAccumulator({ model: "model-a", requireDone: true });
    strict.start();
    strict.push(Buffer.from('data: {"choices":[{"delta":{"content":"complete"},"finish_reason":"stop"}]}\n\n'));
    expect(strict.finish()).toMatchObject({ status: "failed", error: { code: "incomplete_stream" } });

    const truncated = createResponseAccumulator({ model: "MiniMax-M3", requireDone: true, allowFinishReasonAsDone: true });
    truncated.start();
    truncated.push(Buffer.from('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'));
    expect(truncated.finish()).toMatchObject({ status: "failed", error: { code: "incomplete_stream" } });
  });
});
