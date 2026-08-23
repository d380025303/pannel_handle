import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createAgentConversationTranscriptParser, parseAgentConversationText } = require("./agent-conversation-transcript.cjs");

describe("Agent conversation transcript parser", () => {
  it("parses Gemini user and assistant messages and deduplicates updates", () => {
    const messages = parseAgentConversationText("gemini", [
      JSON.stringify({ id: "u1", type: "user", content: "问题", timestamp: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ id: "a1", type: "gemini", content: "答案", timestamp: "2026-01-01T00:00:01Z" }),
      JSON.stringify({ id: "a1", type: "gemini", content: "答案更新", timestamp: "2026-01-01T00:00:02Z" })
    ].join("\n"), { includeUser: true });
    expect(messages.map(message => [message.kind, message.text])).toEqual([["user", "问题"], ["reply", "答案"]]);
  });
  it("parses user-visible Codex history while excluding reasoning and tools", () => {
    const messages = parseAgentConversationText("codex", [
      JSON.stringify({ type: "response_item", timestamp: "2026-01-01T00:00:00Z", payload: { id: "u1", type: "message", role: "user", content: [{ type: "input_text", text: "question" }] } }),
      JSON.stringify({ type: "response_item", payload: { id: "r1", type: "reasoning", role: "assistant", content: [{ type: "output_text", text: "private" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-01-01T00:00:01Z", payload: { id: "a1", type: "message", role: "assistant", phase: "final", content: [{ type: "output_text", text: "answer" }] } })
    ].join("\n"), { includeUser: true });
    expect(messages.map(message => [message.kind, message.text])).toEqual([["user", "question"], ["final", "answer"]]);
  });
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

  it("normalizes current Codex final_answer messages to final replies", () => {
    const parser = createAgentConversationTranscriptParser("codex");

    expect(parser.pushLine(JSON.stringify({
      type: "response_item",
      payload: { type: "message", id: "current-final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "current answer" }] }
    }))).toEqual([
      expect.objectContaining({ id: "current-final", kind: "final", text: "current answer" })
    ]);
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
