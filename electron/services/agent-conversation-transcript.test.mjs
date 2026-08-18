import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createAgentConversationTranscriptParser } = require("./agent-conversation-transcript.cjs");

describe("Agent conversation transcript parser", () => {
  it("extracts Codex commentary and final messages without event duplicates", () => {
    const parser = createAgentConversationTranscriptParser("codex");
    const commentary = {
      timestamp: "2026-08-18T10:00:00.000Z",
      type: "response_item",
      payload: { type: "message", id: "one", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "正在检查。" }] }
    };

    expect(parser.pushLine(JSON.stringify(commentary))).toEqual([
      expect.objectContaining({ id: "one", kind: "commentary", text: "正在检查。" })
    ]);
    expect(parser.pushLine(JSON.stringify(commentary))).toEqual([]);
    expect(parser.pushLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "AgentMessage", id: "one", phase: "commentary" } }
    }))).toEqual([]);
    expect(parser.pushLine(JSON.stringify({
      type: "response_item",
      payload: { type: "message", id: "two", role: "assistant", phase: "final", content: [{ type: "output_text", text: "处理完成。" }] }
    }))).toEqual([expect.objectContaining({ id: "two", kind: "final", text: "处理完成。" })]);
  });

  it("ignores Codex reasoning, tools, users, and unclassified assistant messages", () => {
    const parser = createAgentConversationTranscriptParser("codex");
    const lines = [
      { type: "event_msg", payload: { type: "agent_reasoning", text: "hidden" } },
      { type: "response_item", payload: { type: "function_call", name: "shell_command" } },
      { type: "response_item", payload: { type: "message", role: "user", phase: "commentary", content: [{ type: "output_text", text: "prompt" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "unknown" }] } }
    ];
    expect(lines.flatMap(line => parser.pushLine(JSON.stringify(line)))).toEqual([]);
  });

  it("extracts only CodeBuddy assistant output text and deduplicates provider message IDs", () => {
    const parser = createAgentConversationTranscriptParser("codebuddy");
    const assistant = {
      type: "message",
      id: "row-one",
      role: "assistant",
      content: [{ type: "output_text", text: "先检查配置。" }, { type: "tool_use", name: "read" }],
      providerData: { messageId: "response-one" }
    };
    expect(parser.pushLine(JSON.stringify(assistant))).toEqual([
      expect.objectContaining({ id: "response-one", kind: "reply", text: "先检查配置。" })
    ]);
    expect(parser.pushLine(JSON.stringify({ ...assistant, id: "row-two" }))).toEqual([]);
    expect(parser.pushLine(JSON.stringify({ ...assistant, role: "user", providerData: { messageId: "user-one" } }))).toEqual([]);
    expect(parser.pushLine(JSON.stringify({ type: "reasoning", content: [{ type: "output_text", text: "hidden" }] }))).toEqual([]);
  });
});
