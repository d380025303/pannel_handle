import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createAgentConversationTranscriptParser, parseAgentConversationText } = require("./agent-conversation-transcript.cjs");

describe("Agent conversation transcript parser", () => {
  it("matches the remote Python summary parser for both CLI providers", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "summary-history-"));
    try {
      const file = path.join(directory, "history.jsonl");
      const records = [
        { type: "summary", id: "buddy-summary", timestamp: "2026-01-01T00:00:00Z", summary: "## Buddy\n摘要" },
        { type: "summary", summary: " " },
        { type: "compacted", timestamp: "2026-01-01T00:00:01Z", payload: { message: "## Codex\n摘要" } },
        { type: "compacted", payload: { message: {} } }
      ];
      const text = [...records, ...records].map(record => JSON.stringify(record)).join("\n") + '\n{"type":';
      writeFileSync(file, text);
      const script = readFileSync(new URL("./agent-conversation-history-remote.py", import.meta.url), "utf8").replace(/\nmain\(\)\s*$/, "");
      const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c",
        script + '\nprint(json.dumps({p: parse_messages(p, sys.argv[1]) for p in ["codex", "codebuddy"]}, ensure_ascii=False))', file
      ], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      expect(result.status, result.stderr).toBe(0);
      const remote = JSON.parse(result.stdout);
      for (const provider of ["codex", "codebuddy"])
        expect(remote[provider]).toEqual(parseAgentConversationText(provider, text, { includeUser: true }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.each(["codex", "codebuddy"])("reads %s compaction summaries without replaying replacement history", provider => {
    const summary = (text, timestamp = "2026-01-01T00:00:01Z") => provider === "codex"
      ? { type: "compacted", timestamp, payload: { message: text, replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "replayed" }] }] } }
      : { type: "summary", timestamp, summary: text };
    const parser = createAgentConversationTranscriptParser(provider);
    expect(parser.pushLine(JSON.stringify(summary("  ## 摘要\n保留进度  ")))).toEqual([
      expect.objectContaining({ kind: "summary", text: "## 摘要\n保留进度" })]);
    expect(parser.pushLine(JSON.stringify(summary("  ## 摘要\n保留进度  ")))).toEqual([]);
    expect(parser.pushLine(JSON.stringify(summary("## 摘要\n保留进度", "2026-01-01T00:00:02Z")))).toHaveLength(1);
    for (const text of [undefined, "", " \n", {}]) expect(parser.pushLine(JSON.stringify(summary(text)))).toEqual([]);
    expect(parser.pushLine('{"type":')).toEqual([]);
  });
  it("parses Gemini user and assistant messages and deduplicates updates", () => {
    const messages = parseAgentConversationText("gemini", [
      JSON.stringify({ id: "u1", type: "user", content: "问题", timestamp: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ id: "a1", type: "gemini", content: "答案", timestamp: "2026-01-01T00:00:01Z" }),
      JSON.stringify({ id: "a1", type: "gemini", content: "答案更新", timestamp: "2026-01-01T00:00:02Z" })
    ].join("\n"), { includeUser: true });
    expect(messages.map(message => [message.kind, message.text])).toEqual([["user", "问题"], ["reply", "答案"]]);
  });
  it("parses Grok user and assistant ACP chunks while excluding thoughts", () => {
    const messages = parseAgentConversationText("grok", [
      JSON.stringify({ timestamp: 1, params: { _meta: { eventId: "u1" }, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "问题" } } } }),
      JSON.stringify({ timestamp: 2, params: { _meta: { eventId: "t1" }, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "私有推理" } } } }),
      JSON.stringify({ timestamp: 3, params: { _meta: { eventId: "a1" }, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "答案" } } } })
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
