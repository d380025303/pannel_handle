import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import localOpenCode from "./local-opencode-history.cjs";
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
  const homeDir = fixture();
  const db = new DatabaseSync(path.join(homeDir, ".local", "share", "opencode", "opencode.db"));
  const insert = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)");
  for (const [index, data] of ["{broken", '{"type":"text","text":123}', '{"type":"text","text":" \t "}', '{"type":"text","text":null}'].entries()) {
    insert.run(`invalid_${index}`, "m_reply", "ses_one", 2600 + index, data);
  }
  db.close();
  const history = service(homeDir);
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


it("keeps timers responsive for 10,000 messages and preserves the paging snapshot", async () => {
  const homeDir = fixture();
  const file = path.join(homeDir, ".local", "share", "opencode", "opencode.db");
  const db = new DatabaseSync(file);
  db.exec(`CREATE INDEX message_session ON message(session_id);
    CREATE INDEX part_message ON part(message_id); BEGIN`);
  const insertMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
  const insertPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)");
  const tool = JSON.stringify({ type: "tool", state: { output: "x".repeat(16 * 1024) } });
  const expected = [];
  for (let index = 0; index < 10000; index += 1) {
    const id = `large_${String(index).padStart(5, "0")}`;
    const time = 10000 + Math.floor(index / 2);
    const summary = index % 7 === 0;
    insertMessage.run(id, "ses_one", time, JSON.stringify({ role: "assistant", summary }));
    insertPart.run(`${id}_tool`, id, "ses_one", time, tool);
    insertPart.run(`${id}_text`, id, "ses_one", time + 1, JSON.stringify({ type: "text", text: ` Body ${index} ` }));
    expected.push({ id, provider: "opencode", kind: summary ? "summary" : "reply", text: `Body ${index}`, timestamp: time * 1000 });
  }
  db.exec("COMMIT");
  expected.push({ id: "m_user", provider: "opencode", kind: "user", text: "Question", timestamp: 1200000 },
    { id: "m_reply", provider: "opencode", kind: "reply", text: "Answer\n\ncontinued", timestamp: 2500000 });
  expected.sort((a, b) => b.timestamp - a.timestamp);
  // Compare with the original full-part query and assembly, including stable ties.
  const before = performance.now();
  const legacy = new Map();
  for (const row of db.prepare(`SELECT m.id, m.time_created, json_extract(m.data, '$.role') AS role,
    json_extract(m.data, '$.summary') AS summary, p.data AS part_data
    FROM message m JOIN part p ON p.message_id = m.id
    WHERE m.session_id = ? ORDER BY m.time_created, m.id, p.time_created, p.id`).all("ses_one")) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    const part = JSON.parse(row.part_data);
    if (part.type !== "text" || typeof part.text !== "string" || !part.text.trim()) continue;
    const message = legacy.get(row.id) || { id: row.id, provider: "opencode",
      kind: row.role === "user" ? "user" : row.summary === 1 ? "summary" : "reply",
      text: "", timestamp: row.time_created * 1000 };
    message.text += `${message.text ? "\n\n" : ""}${part.text.trim()}`;
    legacy.set(row.id, message);
  }
  process.stdout.write(`OpenCode legacy synchronous read: ${(performance.now() - before).toFixed(1)} ms\n`);
  expect([...legacy.values()].sort((a, b) => b.timestamp - a.timestamp)).toEqual(expected);
  const history = service(homeDir);
  const request = { panelSessionId: "panel", conversationRef: "opencode:ses_one", limit: 100 };
  for (let trial = 0; trial < 3; trial += 1) {
    let ticks = 0;
    let completed = false;
    const start = performance.now();
    const timer = setInterval(() => { if (!completed) ticks += 1; }, 5);
    const zero = new Promise(resolve => setTimeout(() => resolve({ elapsed: performance.now() - start, completed }), 0));
    let page;
    try {
      page = await history.getHistoryMessages(request);
      completed = true;
    } finally {
      clearInterval(timer);
    }
    const firstTick = await zero;
    process.stdout.write(`OpenCode trial ${trial + 1}: ${(performance.now() - start).toFixed(1)} ms, zero timer ${firstTick.elapsed.toFixed(1)} ms, ${ticks} ticks\n`);
    expect(firstTick.completed).toBe(false);
    expect(ticks).toBeGreaterThan(0);
    expect(page.messages).toEqual(expected.slice(0, 100));
    expect(page.nextCursor).toBe("100");
  }
  // Later pages must use the first-page snapshot even after the database changes.
  db.prepare("UPDATE part SET data = ? WHERE id = ?").run(JSON.stringify({ type: "text", text: "changed" }), "large_09800_text");
  db.close();
  const second = await history.getHistoryMessages({ ...request, cursor: "100" });
  expect(second.messages).toEqual(expected.slice(100, 200));
  const all = [...expected.slice(0, 100), ...second.messages];
  for (let offset = 200; offset < expected.length; offset += 100) {
    const page = await history.getHistoryMessages({ ...request, cursor: String(offset) });
    all.push(...page.messages);
  }
  expect(all).toEqual(expected);
  const refreshed = await history.getHistoryMessages({ ...request, limit: 300 });
  expect(refreshed.messages.find(message => message.id === "large_09800").text).toBe("changed");
}, 30000);


it("keeps timers responsive when repeatedly listing 10,000 sessions and preserves list semantics", async () => {
  const homeDir = fixture();
  const db = new DatabaseSync(path.join(homeDir, ".local", "share", "opencode", "opencode.db"));
  try {
    db.exec(`CREATE INDEX session_directory ON session(directory);
      CREATE INDEX session_parent ON session(parent_id);
      CREATE INDEX message_session ON message(session_id);
      CREATE INDEX part_message ON part(message_id);
      CREATE INDEX part_session ON part(session_id); BEGIN`);
    const insertSession = db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insertMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
    const insertPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)");
    const text = "x".repeat(2048);
    for (let index = 0; index < 10000; index += 1) {
      const id = `list_${String(index).padStart(5, "0")}`;
      const time = 10000 + Math.floor(index / 2);
      insertSession.run(id, null, "C:\\work", index % 9 ? `Task ${index}` : "", time, time, null);
      for (let message = 0; message < 10; message += 1) {
        const messageId = `${id}_${message}`;
        insertMessage.run(messageId, id, time + message, JSON.stringify({ role: message % 2 ? "assistant" : "user" }));
        insertPart.run(messageId, messageId, id, time + message, JSON.stringify({ type: "text", text: `${index} ${text}` }));
      }
    }
    db.exec("COMMIT");
    // The unchanged synchronous reader provides the pre-Worker behavior baseline.
    const items = localOpenCode.readLocalOpenCodeList({ homeDir, cwd: "C:\\work", scope: "cwd",
      fsApi: fs, Database: DatabaseSync });
    expect(items).toHaveLength(10001);
    const history = service(homeDir);
    const request = { panelSessionId: "panel", providers: ["opencode"], limit: 50 };
    const expected = historyModule.filterAndPage(items, request);
    for (let trial = 0; trial < 3; trial += 1) {
      let completed = false;
      let ticks = 0;
      const start = performance.now();
      const zero = new Promise(resolve => setTimeout(() => resolve({ elapsed: performance.now() - start, completed }), 0));
      const timer = setInterval(() => { if (!completed) ticks += 1; }, 5);
      let page;
      try {
        page = await history.listHistory(request);
        completed = true;
      } finally {
        clearInterval(timer);
      }
      const firstTick = await zero;
      process.stdout.write(`OpenCode list trial ${trial + 1}: ${(performance.now() - start).toFixed(1)} ms, zero timer ${firstTick.elapsed.toFixed(1)} ms, ${ticks} ticks\n`);
      expect(firstTick.completed).toBe(false);
      expect(ticks).toBeGreaterThan(0);
      expect(page).toEqual({ ...expected, errors: [] });
    }
    // Paging retains the snapshot; a first-page refresh sees new database contents.
    db.prepare("UPDATE session SET title = 'Changed title' WHERE id = 'list_09900'").run();
    const second = await history.listHistory({ ...request, cursor: "50" });
    expect(second).toEqual({ ...historyModule.filterAndPage(items, { ...request, cursor: "50" }), errors: [] });
    const refreshed = await history.listHistory({ ...request, query: "Changed title" });
    expect(refreshed.items).toEqual([expect.objectContaining({ ref: "opencode:list_09900", title: "Changed title" })]);
    for (const filters of [
      { scope: "all", includeArchived: true },
      { query: "Question" },
      { query: "Task 999" }
    ]) {
      const baseline = localOpenCode.readLocalOpenCodeList({ homeDir, cwd: "C:\\work", scope: "cwd",
        ...filters, fsApi: fs, Database: DatabaseSync });
      const result = await history.listHistory({ ...request, ...filters });
      expect(result).toEqual({ ...historyModule.filterAndPage(baseline, { ...request, ...filters }), errors: [] });
    }
  } finally {
    db.close();
  }
}, 30000);
