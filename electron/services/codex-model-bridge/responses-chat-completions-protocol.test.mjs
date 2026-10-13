import { describe, expect, it } from "vitest";
import protocol from "./responses-chat-completions-protocol.cjs";

const { MAX_STREAM_LINE_BYTES, responsesToChat, createResponseAccumulator } = protocol;

describe("Responses to Chat Completions protocol", () => {
  it.each([false, true])("keeps client search separate from a same-named function (reversed: %s)", reversed => {
    const functionTool = { type: "function", name: "tool_search", parameters: { type: "object", properties: { recordId: { type: "string" } } } };
    const searchTool = { type: "tool_search", execution: "client" };
    const tools = reversed ? [searchTool, functionTool] : [functionTool, searchTool];
    const converted = responsesToChat({ tools, input: [
      { type: "function_call", call_id: "function-1", name: "tool_search", arguments: '{"recordId":"42"}' },
      { type: "tool_search_call", call_id: "search-1", arguments: { query: "tools" } }
    ] });
    expect(converted.request.tools).toHaveLength(2);
    const functionAlias = converted.request.tools.find(tool => tool.function.parameters.properties.recordId).function.name;
    const searchAlias = converted.request.tools.find(tool => tool.function.parameters.properties.query).function.name;
    expect(functionAlias).not.toBe(searchAlias);
    expect(converted.request.messages[0].tool_calls.map(call => call.function.name)).toEqual([functionAlias, searchAlias]);

    const accumulator = createResponseAccumulator({ model: "test", ...converted });
    accumulator.push(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
      { index: 0, id: "function-1", function: { name: functionAlias, arguments: '{"recordId":"42"}' } },
      { index: 1, id: "search-1", function: { name: searchAlias, arguments: '{"query":"tools"}' } }
    ] } }] })}\n\n`));
    const output = accumulator.finish().output;
    expect(output[0]).toMatchObject({ type: "function_call", name: "tool_search", arguments: '{"recordId":"42"}' });
    expect(output[1]).toMatchObject({ type: "tool_search_call", execution: "client", arguments: { query: "tools" } });

    for (const [choice, alias] of [
      [{ type: "function", name: "tool_search" }, functionAlias],
      [{ type: "tool_search" }, searchAlias],
      [{ type: "tool_search", name: "tool_search" }, searchAlias]
    ]) {
      const selected = responsesToChat({ tools, tool_choice: choice });
      expect(selected.request.tools.map(tool => tool.function.name)).toEqual([alias]);
      expect(selected.request.tool_choice).toBe("required");
    }
    expect(() => responsesToChat({ tools: [functionTool], tool_choice: { type: "tool_search" } })).toThrow("unavailable tool");
    expect(() => responsesToChat({ tools: [searchTool], tool_choice: { type: "function", name: "tool_search" } })).toThrow("unavailable tool");
  });

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
    expect(result.customTools.has(JSON.stringify(["", "apply_patch"]))).toBe(true);
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

  it.each(["function", "custom"])("keeps flat and namespaced %s tools distinct", kind => {
    const parameters = [
      { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      { type: "object", properties: { id: { type: "integer" } }, required: ["id"] }
    ];
    const tools = [
      { type: "function", name: "files__read", parameters: parameters[0] },
      { type: "namespace", name: "files", tools: [{ type: kind, name: "read", parameters: parameters[1] }] }
    ];
    const calls = [
      { type: "function_call", call_id: "flat", name: "files__read", arguments: '{"path":"a.txt"}' },
      kind === "custom"
        ? { type: "custom_tool_call", call_id: "nested", namespace: "files", name: "read", input: "read a.txt" }
        : { type: "function_call", call_id: "nested", namespace: "files", name: "read", arguments: '{"id":7}' }
    ];
    const converted = responsesToChat({ tools, input: calls });
    expect(converted.request.tools).toHaveLength(2);
    const aliases = converted.request.tools.map(tool => tool.function.name);
    expect(new Set(aliases).size).toBe(2);
    expect(converted.request.tools[0].function.parameters).toEqual(parameters[0]);
    expect(converted.request.tools[1].function.parameters).toEqual(kind === "custom"
      ? { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false }
      : parameters[1]);
    expect(converted.request.messages[0].tool_calls.map(call => call.function.name)).toEqual(aliases);
    calls.forEach((call, index) => {
      const selected = responsesToChat({ tools, tool_choice: { type: index ? kind : "function", name: call.name, ...(call.namespace ? { namespace: call.namespace } : {}) } });
      expect(selected.request.tools.map(tool => tool.function.name)).toEqual([aliases[index]]);
      expect(selected.request.tool_choice).toBe("required");
    });
    const parser = createResponseAccumulator({ ...converted, model: "model-a" });
    parser.start();
    parser.push(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: converted.request.messages[0].tool_calls.map((call, index) => ({ ...call, index })) } }] })}\n\n`));
    const output = parser.finish().output;
    expect(output).toHaveLength(2);
    output.forEach((item, index) => {
      expect(item).toMatchObject(calls[index]);
      if (!index) expect(item).not.toHaveProperty("namespace");
    });
  });

  it("rejects provider-hosted tools and unavailable forced tools instead of silently degrading", () => {
    expect(() => responsesToChat({ tools: [{ type: "web_search", external_web_access: true }] })).toThrow("tool type is not supported");
    expect(() => responsesToChat({ tools: [{ type: "function", name: "exec_command" }], tool_choice: { type: "function", name: "missing" } })).toThrow("tool_choice references an unavailable tool");
  });

  it.each([false, true])("validates forced tools against current definitions (with history: %s)", withHistory => {
    const input = withHistory ? [
      { type: "function_call", call_id: "removed-1", name: "removed", arguments: "{}" },
      { type: "function_call_output", call_id: "removed-1", output: "done" }
    ] : [];
    const tools = [{ type: "function", name: "available" }];
    expect(() => responsesToChat({ input, tools, tool_choice: { type: "function", name: "removed" } })).toThrow(expect.objectContaining({
      statusCode: 400,
      message: "Codex tool_choice references an unavailable tool: removed."
    }));

    const selected = responsesToChat({ input, tools, tool_choice: { type: "function", name: "available" } });
    expect(selected.request.tools).toHaveLength(1);
    expect(selected.toolAliases.get(selected.request.tools[0].function.name)).toBe("available");
    expect(selected.request.tool_choice).toBe("required");
  });

  it("rejects forced tool search when only its historical alias exists", () => {
    expect(() => responsesToChat({
      input: [
        { type: "tool_search_call", call_id: "search-1", arguments: { query: "tools" } },
        { type: "tool_search_output", call_id: "search-1", tools: [] }
      ],
      tools: [{ type: "function", name: "available" }],
      tool_choice: { type: "tool_search" }
    })).toThrow(expect.objectContaining({
      statusCode: 400,
      message: "Codex tool_choice references an unavailable tool: tool_search."
    }));
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
    expect([...followUp.toolAliases.values()]).toContain("get_issue");

    const mcpAlias = [...followUp.toolAliases].find(([, name]) => name === "get_issue")[0];
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

  it("preserves UTF-8 characters split across upstream chunks", () => {
    const parser = createResponseAccumulator({ model: "model-a", requireDone: true });
    parser.start();
    const wire = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "中文" } }] })}\n\ndata: [DONE]\n\n`);
    const split = wire.indexOf(Buffer.from("中")) + 1;
    parser.push(wire.subarray(0, split));
    parser.push(wire.subarray(split));

    expect(parser.finish().output[0].content[0].text).toBe("中文");
  });

  it("fails on malformed JSON even if the upstream later sends [DONE]", () => {
    const parser = createResponseAccumulator({ model: "model-a", requireDone: true });
    parser.start();
    parser.push(Buffer.from("data: {bad-json}\n\ndata: [DONE]\n\n"));

    expect(parser.finish()).toMatchObject({ status: "failed", error: { code: "invalid_stream" } });
  });

  it("bounds an upstream line without a newline", () => {
    const parser = createResponseAccumulator({ model: "model-a", requireDone: true });
    parser.start();
    parser.push(Buffer.from("data: " + "x".repeat(MAX_STREAM_LINE_BYTES)));

    expect(parser.finish()).toMatchObject({ status: "failed", error: { code: "stream_line_too_large" } });
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

  it.each([
    [false, "length", "max_output_tokens"], [true, "length", "max_output_tokens"],
    [false, "content_filter", "content_filter"], [true, "content_filter", "content_filter"]
  ])("marks text and all tool kinds incomplete (omit DONE: %s, reason: %s)", (omitDone, finishReason, reason) => {
    const events = [];
    const parser = createResponseAccumulator({
      model: "model-a", requireDone: true, allowFinishReasonAsDone: omitDone,
      customTools: new Set(["patch"]), toolKinds: new Map([["search", "tool_search"]]),
      emit: event => events.push(event)
    });
    parser.start();
    const argumentsText = '{"input":"truncated';
    parser.push(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: {
      content: "partial",
      tool_calls: ["echo", "patch", "search"].map((name, index) => ({ index, id: `call-${index}`, function: { name, arguments: argumentsText } }))
    }, finish_reason: null }] })}\n\n`));
    parser.push(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`));
    parser.push(Buffer.from('data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n'));
    if (!omitDone) parser.push(Buffer.from("data: [DONE]\n\n"));
    const response = parser.finish();
    expect(response).toMatchObject({ status: "incomplete", incomplete_details: { reason }, usage: { total_tokens: 5 } });
    expect(response.output.map(item => item.type)).toEqual(["message", "function_call", "custom_tool_call", "tool_search_call"]);
    expect(response.output.every(item => item.status === "incomplete")).toBe(true);
    expect(response.output[1].arguments).toBe(argumentsText);
    expect(response.output[2].input).toBe(argumentsText);
    expect(events.filter(event => event.type === "response.output_item.done").every(event => event.item.status === "incomplete")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "response.incomplete", response });
    expect(events.some(event => event.type === "response.completed")).toBe(false);
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
