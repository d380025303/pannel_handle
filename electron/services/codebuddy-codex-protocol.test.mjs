import { describe, expect, it } from "vitest";
import protocol from "./codebuddy-codex-protocol.cjs";

const { responsesToChat, createResponseAccumulator } = protocol;

describe("CodeBuddy Codex protocol", () => {
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

  it("normalizes developer messages and hides unsupported Codex tools", () => {
    const result = responsesToChat({ input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "follow repository rules" }] }
    ], tools: [
      { type: "function", name: "exec_command", description: "Run a command", parameters: { type: "object" } },
      { type: "function", name: "web_search", description: "Search the web", parameters: { type: "object" } }
    ] });
    expect(result.request.messages[0]).toEqual({ role: "system", content: "follow repository rules" });
    expect(result.request.tools).toHaveLength(1);
    expect([...result.toolAliases.values()]).toEqual(["exec_command"]);
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
});
