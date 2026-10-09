import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import historyModule from "./agent-conversation-history-service.cjs";

const { createAgentConversationHistoryService } = historyModule;
const homes = [];

function fixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-history-"));
  homes.push(homeDir);
  const root = path.join(homeDir, ".local", "share", "opencode");
  fs.mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(path.join(root, "opencode.db"));
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
    time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
  const session = db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)");
  session.run("ses_one", null, "C:\\work", "OpenCode task", 1000, 4000, null);
  session.run("ses_archived", null, "C:\\work", "Old task", 500, 3000, 3000);
  session.run("ses_child", "ses_one", "C:\\work", "Subagent", 1100, 2900, null);
  session.run("ses_other", null, "C:\\other", "Other project", 100, 200, null);
  const message = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
  const part = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)");
  for (const [id, role, time, pieces] of [
    ["m_user", "user", 1200, [["text", "Question"], ["file", "secret file"]]],
    ["m_reply", "assistant", 2500, [["reasoning", "private reasoning"], ["tool", "private tool"], ["text", "Answer"], ["text", "continued"]]]
  ]) {
    message.run(id, "ses_one", time, JSON.stringify({ role }));
    pieces.forEach(([type, text], index) => part.run(`${id}_${index}`, id, "ses_one", time + index, JSON.stringify({ type, text })));
  }
  db.close();
  return homeDir;
}

function service(homeDir) {
  return createAgentConversationHistoryService({ homeDir,
    terminalManager: { getSession: () => ({ id: "panel", type: "windows", cwd: "C:\\work" }) } });
}

afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });

it("lists OpenCode sessions with directory, archive, search, and pagination filters", async () => {
  const history = service(fixture());
  const current = await history.listHistory({ panelSessionId: "panel", providers: ["opencode"] });
  expect(current.errors).toEqual([]);
  expect(current.items).toEqual([expect.objectContaining({ ref: "opencode:ses_one", title: "OpenCode task",
    preview: "Question", cwd: "C:\\work", archived: false })]);
  const first = await history.listHistory({ panelSessionId: "panel", providers: ["opencode"], scope: "all", includeArchived: true, limit: 1 });
  expect(first.nextCursor).toBe("1");
  const second = await history.listHistory({ panelSessionId: "panel", providers: ["opencode"], scope: "all", includeArchived: true, cursor: "1", limit: 1 });
  expect(second.items[0].ref).toBe("opencode:ses_archived");
  const search = await history.listHistory({ panelSessionId: "panel", providers: ["opencode"], query: "Question" });
  expect(search.items.map(item => item.ref)).toEqual(["opencode:ses_one"]);
});

it("returns only visible user and assistant text", async () => {
  const history = service(fixture());
  const detail = await history.getHistoryMessages({ panelSessionId: "panel", conversationRef: "opencode:ses_one" });
  expect(detail.messages.map(message => [message.kind, message.text])).toEqual([
    ["reply", "Answer\n\ncontinued"], ["user", "Question"]
  ]);
  expect(JSON.stringify(detail)).not.toMatch(/private|secret/);
  await expect(history.getHistoryMessages({ panelSessionId: "panel", conversationRef: "opencode:ses_child" })).rejects.toThrow("unavailable");
});

it("treats a missing database as empty history", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-history-empty-"));
  homes.push(homeDir);
  const result = await service(homeDir).listHistory({ panelSessionId: "panel", providers: ["opencode"] });
  expect(result).toMatchObject({ items: [], errors: [] });
});

it("labels OpenCode assistant summary messages in local and remote history", async () => {
  const homeDir = fixture();
  const db = new DatabaseSync(path.join(homeDir, ".local", "share", "opencode", "opencode.db"));
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m_summary", "ses_one", 3000, JSON.stringify({ role: "assistant", summary: true }));
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run("p_summary", "m_summary", "ses_one", 3000, JSON.stringify({ type: "text", text: "Conversation summary" }));
  db.close();
  const payload = { conversationRef: "opencode:ses_one", limit: 100 };
  const local = await service(homeDir).getHistoryMessages({ ...payload, panelSessionId: "panel" });
  expect(local.messages[0]).toMatchObject({ kind: "summary", text: "Conversation summary" });
  const remote = spawnSync(process.platform === "win32" ? "python" : "python3", [
    path.join(import.meta.dirname, "agent-conversation-history-remote.py"), "messages", Buffer.from(JSON.stringify(payload)).toString("base64")
  ], { encoding: "utf8", env: { ...process.env, XDG_DATA_HOME: path.join(homeDir, ".local", "share") } });
  expect(remote.status, remote.stderr).toBe(0);
  expect(JSON.parse(remote.stdout).messages).toEqual(local.messages);
});

it("reads the same OpenCode history through the remote Python parser", () => {
  const homeDir = fixture();
  const python = process.platform === "win32" ? "python" : "python3";
  const script = path.join(import.meta.dirname, "agent-conversation-history-remote.py");
  const run = (action, payload) => {
    const result = spawnSync(python, [script, action, Buffer.from(JSON.stringify(payload)).toString("base64")], {
      encoding: "utf8", env: { ...process.env, XDG_DATA_HOME: path.join(homeDir, ".local", "share") }
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const list = run("list", { providers: ["opencode"], cwd: "C:\\work", scope: "cwd", limit: 50 });
  expect(list.errors).toEqual([]);
  expect(list.items.map(item => item.ref)).toEqual(["opencode:ses_one"]);
  const detail = run("messages", { conversationRef: "opencode:ses_one", limit: 100 });
  expect(detail.messages.map(message => [message.kind, message.text])).toEqual([
    ["reply", "Answer\n\ncontinued"], ["user", "Question"]
  ]);
});
