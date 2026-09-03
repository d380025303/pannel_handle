import { describe, expect, it } from "vitest";
import minimaxModule from "./minimax-service.cjs";

const { adaptMiniMaxChatRequest, minimaxContextWindow, transformMiniMaxModels } = minimaxModule;

describe("MiniMax Codex adapter", () => {
  it("enriches the sparse OpenAI-compatible model list", () => {
    expect(transformMiniMaxModels([{ id: "MiniMax-M2.7" }, { id: "MiniMax-M3" }])).toEqual([
      expect.objectContaining({ id: "MiniMax-M2.7", context_length: 204800, supported_parameters: ["tools", "tool_choice"] }),
      expect.objectContaining({ id: "MiniMax-M3", context_length: 1000000, supported_parameters: ["tools", "tool_choice"] })
    ]);
    expect(minimaxContextWindow("future-model")).toBe(128000);
  });

  it("maps Codex output limits and removes unsupported Chat Completions fields", () => {
    const request = adaptMiniMaxChatRequest({
      model: "MiniMax-M2.7",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 9000,
      parallel_tool_calls: true,
      reasoning_effort: "high",
      stream_options: { include_usage: true },
      tools: [{ type: "function", function: { name: "echo", strict: true, parameters: {} } }]
    });
    expect(request).toMatchObject({ model: "MiniMax-M2.7", max_completion_tokens: 2048 });
    expect(request).not.toHaveProperty("max_tokens");
    expect(request).not.toHaveProperty("parallel_tool_calls");
    expect(request).not.toHaveProperty("reasoning_effort");
    expect(request).not.toHaveProperty("stream_options");
    expect(request.tools[0].function).not.toHaveProperty("strict");
  });
});
