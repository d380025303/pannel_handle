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
it("lists 3,000 summaries without blocking timers and preserves metadata and filtering", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-list-"));
  const oldHome = process.env.GROK_HOME;
  delete process.env.GROK_HOME;
  try {
    const workspace = path.join(homeDir, ".grok", "sessions", "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    for (let index = 0; index < 3000; index++) {
      const id = `11111111-1111-1111-1111-${String(index).padStart(12, "0")}`;
      const directory = path.join(workspace, id);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify({
        info: { cwd: "C:\\other" }, generated_title: `Title ${index}`, session_summary: " preview ",
        created_at: 1700000000000, last_active_at: 1700000001000
      }));
    }
    let pending = 0;
    let peak = 0;
    const fsApi = { promises: Object.fromEntries(["readdir", "readFile", "stat"].map(method => [method, async (...args) => {
      peak = Math.max(peak, ++pending);
      try { return await fs.promises[method](...args); } finally { pending--; }
    }])) };
    let completed = false;
    let timerDuringQuery = false;
    const timer = setTimeout(() => { timerDuringQuery = !completed; }, 0);
    const items = await localModule.listLocalGrok({ homeDir, cwd: "C:\\missing", scope: "cwd", fsApi });
    completed = true;
    clearTimeout(timer);
    expect(items).toEqual([]);
    expect(timerDuringQuery).toBe(true);
    expect(peak).toBeLessThanOrEqual(16);
    const all = await localModule.listLocalGrok({ homeDir, scope: "all", fsApi });
    expect(all).toHaveLength(3000);
    expect(all.find(item => item.title === "Title 0")).toEqual({
      ref: "grok:11111111-1111-1111-1111-000000000000", provider: "grok", title: "Title 0",
      preview: "preview", cwd: "C:\\other", createdAt: 1700000000000, updatedAt: 1700000001000, archived: false
    });
    const first = path.join(workspace, "11111111-1111-1111-1111-000000000000", "summary.json");
    fs.writeFileSync(first, JSON.stringify({ info: { cwd: "C:\\match" } }));
    const matched = await localModule.listLocalGrok({ homeDir, cwd: "C:\\match", scope: "cwd", fsApi });
    expect(matched).toHaveLength(1);
    expect(matched[0].updatedAt).toBe((await fs.promises.stat(first)).mtimeMs);
    fs.writeFileSync(first, "invalid json");
    expect(await localModule.listLocalGrok({ homeDir, cwd: "C:\\match", scope: "cwd", fsApi })).toEqual([]);
    expect(await localModule.getGrokSessionDirectories(fsApi, path.join(homeDir, "missing"))).toEqual([]);
  } finally {
    if (oldHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = oldHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}, 30000);
