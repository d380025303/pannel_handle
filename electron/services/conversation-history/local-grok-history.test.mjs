import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import localModule from "./local-grok-history.cjs";

const script = fileURLToPath(new URL("./agent-conversation-history-remote.py", import.meta.url));
const sessionId = "11111111-1111-1111-1111-111111111111";
const block = text => ({ type: "text", text });

it.each([
  ["array chunk boundary", [[block("Hello ")], [block("world")]], "Hello world"],
  ["whitespace-only chunk", [[block("Hello")], [block(" \t ")], [block("world")]], "Hello \t world"],
  ["newline chunk", [[block("Hello")], [block("\n")], [block("world")]], "Hello\nworld"],
  ["multiple text blocks", [[block(" Hello "), { type: "image", text: "ignored" }, { type: "output_text", text: "world" }, { type: "input_text", text: "\nnext " }]], "Hello world\nnext"],
  ["string and object chunks", [" Hello ", { text: "world\n" }, { text: "next " }], "Hello world\nnext"],
  ["invalid content", [null, 42, { text: 42 }, [null, { type: "text", text: 42 }], [block("Hello world")]], "Hello world"],
  ["only whitespace", [[block(" \t")], { text: "\n" }], null]
])("keeps local and remote Grok messages consistent for %s", (_name, contents, expected) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-history-"));
  try {
    const directory = path.join(root, "sessions", "workspace", sessionId);
    fs.mkdirSync(directory, { recursive: true });
    // Exercise both user and agent chunks with the same prompt ID.
    const transcript = ["user_message_chunk", "agent_message_chunk"].flatMap(sessionUpdate =>
      contents.map(content => JSON.stringify({ timestamp: 1700000000000,
        params: { _meta: { promptId: "prompt-1" }, update: { sessionUpdate, content } } }))
    ).join("\n");
    fs.writeFileSync(path.join(directory, "updates.jsonl"), transcript);
    const local = localModule.parseGrokMessages(transcript);
    const payload = { conversationRef: `grok:${sessionId}` };
    const result = spawnSync(process.platform === "win32" ? "python" : "python3",
      [script, "messages", Buffer.from(JSON.stringify(payload)).toString("base64")],
      { encoding: "utf8", env: { ...process.env, GROK_HOME: root }, timeout: 10000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).messages).toEqual(local);
    expect(local.map(message => message.text)).toEqual(expected === null ? [] : [expected, expected]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
