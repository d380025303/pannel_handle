import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import historyModule from "./agent-conversation-history-service.cjs";

const { createAgentConversationHistoryService } = historyModule;
const temporaryDirectories = [];

function createFixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conversation-history-"));
  temporaryDirectories.push(homeDir);
  const codexRoot = path.join(homeDir, ".codex");
  fs.mkdirSync(codexRoot, { recursive: true });
  const rollout = path.join(codexRoot, "codex-one.jsonl");
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: "response_item", timestamp: "2026-08-20T01:00:00Z", payload: { id: "u1", type: "message", role: "user", content: [{ type: "input_text", text: "Codex question" }] } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-08-20T01:01:00Z", payload: { id: "r1", type: "reasoning", summary: "private" } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-08-20T01:02:00Z", payload: { id: "a1", type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Codex progress" }] } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-08-20T01:03:00Z", payload: { id: "a2", type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Codex answer" }] } })
  ].join("\n"), "utf-8");

  const database = new DatabaseSync(path.join(codexRoot, "state_5.sqlite"));
  database.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT,
    created_at INTEGER, updated_at INTEGER, archived INTEGER,
    first_user_message TEXT, preview TEXT, source TEXT,
    recency_at_ms INTEGER, updated_at_ms INTEGER
  )`);
  const insert = database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("codex-one", rollout, "\\\\?\\C:\\work", "Codex title", 100, 200, 0, "Codex question", "", "cli", 200000, 200000);
  insert.run("codex-archived", rollout, "C:\\other", "Archived title", 50, 150, 1, "Archived question", "", "cli", 150000, 150000);
  insert.run("codex-subagent", rollout, "C:\\work", "Subagent", 50, 300, 0, "Subagent question", "", '{"subagent":{}}', 300000, 300000);
  database.close();

  const codeBuddyRoot = path.join(homeDir, ".codebuddy", "projects", "c-work");
  fs.mkdirSync(codeBuddyRoot, { recursive: true });
  fs.writeFileSync(path.join(codeBuddyRoot, "buddy-one.jsonl"), [
    JSON.stringify({ id: "bu1", timestamp: 250000, type: "message", role: "user", content: [{ type: "input_text", text: "Buddy question" }], cwd: "c:\\work" }),
    JSON.stringify({ id: "reason", timestamp: 260000, type: "reasoning", content: [{ type: "output_text", text: "private" }], cwd: "c:\\work" }),
    JSON.stringify({ id: "title", timestamp: 270000, type: "ai-title", aiTitle: "Buddy title", cwd: "c:\\work" }),
    JSON.stringify({ id: "ba1", timestamp: 280000, type: "message", role: "assistant", content: [{ type: "output_text", text: "Buddy answer" }], providerData: { messageId: "buddy-answer" }, cwd: "c:\\work" })
  ].join("\n"), "utf-8");

  const projectHash = crypto.createHash("sha256").update("C:\\work").digest("hex");
  const geminiRoot = path.join(homeDir, ".gemini", "tmp", projectHash, "chats");
  fs.mkdirSync(geminiRoot, { recursive: true });
  fs.writeFileSync(path.join(geminiRoot, "session-one.jsonl"), [
    JSON.stringify({ sessionId: "gemini-one", projectHash, startTime: "2026-08-20T02:00:00Z", lastUpdated: "2026-08-20T02:02:00Z" }),
    JSON.stringify({ id: "gu1", timestamp: "2026-08-20T02:00:00Z", type: "user", content: "Gemini question" }),
    JSON.stringify({ id: "ga1", timestamp: "2026-08-20T02:01:00Z", type: "gemini", content: "obsolete" }),
    JSON.stringify({ $set: { messages: [
      { id: "gu1", timestamp: "2026-08-20T02:00:00Z", type: "user", content: "Gemini question" },
      { id: "ga2", timestamp: "2026-08-20T02:02:00Z", type: "gemini", content: "Gemini answer" }
    ] } })
  ].join("\n"), "utf-8");

  const grokSession = path.join(homeDir, ".grok", "sessions", "C%3A%5Cwork", "019f877f-f9bd-7d03-bc33-9bebe6a9529f");
  fs.mkdirSync(grokSession, { recursive: true });
  fs.writeFileSync(path.join(grokSession, "summary.json"), JSON.stringify({
    info: { id: "019f877f-f9bd-7d03-bc33-9bebe6a9529f", cwd: "C:\\work" },
    generated_title: "Grok title",
    session_summary: "Grok summary",
    created_at: "2026-08-20T03:00:00Z",
    updated_at: "2026-08-20T03:02:00Z"
  }), "utf-8");
  fs.writeFileSync(path.join(grokSession, "updates.jsonl"), [
    JSON.stringify({ timestamp: 300000, params: { _meta: { promptId: "prompt-1", eventId: "user-1", chunkId: 1 }, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Grok question" } } } }),
    JSON.stringify({ timestamp: 301000, params: { _meta: { promptId: "prompt-1", eventId: "agent-1", chunkId: 2 }, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Grok " } } } }),
    JSON.stringify({ timestamp: 302000, params: { _meta: { promptId: "prompt-1", eventId: "agent-2", chunkId: 3 }, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } } })
  ].join("\n"), "utf-8");
  return homeDir;
}

function localService(homeDir) {
  return createAgentConversationHistoryService({
    homeDir,
    terminalManager: { getSession: vi.fn(() => ({ id: "run-1", type: "windows", cwd: "C:\\work" })) }
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Agent conversation history service", () => {
  it("combines Codex and CodeBuddy history for the current cwd without archived or subagent rows", async () => {
    const service = localService(createFixture());
    const result = await service.listHistory({ panelSessionId: "run-1", providers: ["codex", "codebuddy"], scope: "cwd" });

    expect(result.errors).toEqual([]);
    expect(result.items.map(item => [item.provider, item.title])).toEqual([
      ["codebuddy", "Buddy title"],
      ["codex", "Codex title"]
    ]);
    expect(result.items.every(item => !Object.hasOwn(item, "rollout_path"))).toBe(true);
  });

  it("supports all-directory, archived, search, and cursor pagination", async () => {
    const service = localService(createFixture());
    const result = await service.listHistory({
      panelSessionId: "run-1",
      providers: ["codex"],
      scope: "all",
      includeArchived: true,
      query: "title",
      limit: 1
    });
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe("1");
    const next = await service.listHistory({ panelSessionId: "run-1", providers: ["codex"], scope: "all", includeArchived: true, query: "title", cursor: result.nextCursor, limit: 1 });
    expect(next.items[0].archived).toBe(true);
  });

  it("finds an older cwd after more than 5000 newer Codex threads locally and remotely", async () => {
    const homeDir = createFixture();
    const database = new DatabaseSync(path.join(homeDir, ".codex", "state_5.sqlite"));
    const insert = database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    database.exec("BEGIN");
    for (let index = 0; index < 5001; index++) {
      insert.run(`newer-${index}`, "", "C:\\other", "Newer", 1000 + index, 1000 + index,
        0, "Question", "", "cli", 1_000_000 + index, 1_000_000 + index);
    }
    database.exec("COMMIT");
    database.close();

    const local = await localService(homeDir).listHistory({ panelSessionId: "run-1", providers: ["codex"], scope: "cwd" });
    expect(local.items.map(item => item.ref)).toEqual(["codex:codex-one"]);

    const python = process.platform === "win32" ? "python" : "python3";
    const script = path.join(import.meta.dirname, "agent-conversation-history-remote.py");
    const payload = { providers: ["codex"], cwd: "\\\\?\\C:\\work", scope: "cwd", limit: 50 };
    const result = spawnSync(python, [script, "list", Buffer.from(JSON.stringify(payload)).toString("base64")], {
      encoding: "utf8", env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir }
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).items.map(item => item.ref)).toEqual(["codex:codex-one"]);
  });

  it("returns only user-visible messages newest first", async () => {
    const service = localService(createFixture());
    const codex = await service.getHistoryMessages({ panelSessionId: "run-1", conversationRef: "codex:codex-one" });
    expect(codex.messages.map(message => [message.kind, message.text])).toEqual([
      ["final", "Codex answer"],
      ["commentary", "Codex progress"],
      ["user", "Codex question"]
    ]);
    const buddy = await service.getHistoryMessages({ panelSessionId: "run-1", conversationRef: "codebuddy:buddy-one" });
    expect(buddy.messages.map(message => message.text)).toEqual(["Buddy answer", "Buddy question"]);
    expect(JSON.stringify([...codex.messages, ...buddy.messages])).not.toContain("private");
  });

  it("parses the same Codex final_answer from the remote Python reader", () => {
    const homeDir = createFixture();
    const python = process.platform === "win32" ? "python" : "python3";
    const script = path.join(import.meta.dirname, "agent-conversation-history-remote.py");
    const payload = { conversationRef: "codex:codex-one", limit: 100 };
    const result = spawnSync(python, [script, "messages", Buffer.from(JSON.stringify(payload)).toString("base64")], {
      encoding: "utf8", env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir }
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).messages.map(message => [message.kind, message.text])).toEqual([
      ["final", "Codex answer"], ["commentary", "Codex progress"], ["user", "Codex question"]
    ]);
  });

  it("reuses a local list snapshot for later pages and refreshes the first page", async () => {
    const homeDir = createFixture();
    const projectRoot = path.join(homeDir, ".codebuddy", "projects", "c-work");
    fs.copyFileSync(path.join(projectRoot, "buddy-one.jsonl"), path.join(projectRoot, "buddy-two.jsonl"));
    const readdirSync = vi.fn((...args) => fs.readdirSync(...args));
    const service = createAgentConversationHistoryService({ homeDir,
      fsApi: { ...fs, readdirSync },
      terminalManager: { getSession: () => ({ id: "run-1", type: "windows", cwd: "C:\\work" }) } });
    const request = { panelSessionId: "run-1", providers: ["codebuddy"], scope: "cwd", limit: 1 };
    const first = await service.listHistory(request);
    expect(first.nextCursor).toBe("1");
    const scans = readdirSync.mock.calls.length;
    const second = await service.listHistory({ ...request, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].ref).not.toBe(first.items[0].ref);
    expect(readdirSync).toHaveBeenCalledTimes(scans);
    fs.copyFileSync(path.join(projectRoot, "buddy-one.jsonl"), path.join(projectRoot, "buddy-three.jsonl"));
    const refreshed = await service.listHistory({ ...request, limit: 3 });
    expect(readdirSync.mock.calls.length).toBeGreaterThan(scans);
    expect(refreshed.items.map(item => item.ref)).toContain("codebuddy:buddy-three");
  });

  it("lists and reads Gemini project history with checkpoint semantics", async () => {
    const service = localService(createFixture());
    const history = await service.listHistory({ panelSessionId: "run-1", providers: ["gemini"], scope: "cwd" });
    expect(history.errors).toEqual([]);
    expect(history.items[0]).toMatchObject({ provider: "gemini", title: "Gemini question", cwd: "C:\\work" });
    const detail = await service.getHistoryMessages({ panelSessionId: "run-1", conversationRef: history.items[0].ref });
    expect(detail.messages.map(message => message.text)).toEqual(["Gemini answer", "Gemini question"]);
    expect(JSON.stringify(detail.messages)).not.toContain("obsolete");
  });

  it("reads Gemini history through the remote Python reader", () => {
    const homeDir = createFixture();
    const python = process.platform === "win32" ? "python" : "python3";
    const script = path.join(import.meta.dirname, "agent-conversation-history-remote.py");
    const run = (action, payload) => {
      const result = spawnSync(python, [script, action, Buffer.from(JSON.stringify(payload)).toString("base64")], {
        encoding: "utf8", env: { ...process.env, GEMINI_CLI_HOME: homeDir }
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    const list = run("list", { providers: ["gemini"], cwd: "C:\\work", scope: "cwd", limit: 50 });
    expect(list.items.map(item => item.title)).toEqual(["Gemini question"]);
    const detail = run("messages", { conversationRef: list.items[0].ref, limit: 100 });
    expect(detail.messages.map(message => message.text)).toEqual(["Gemini answer", "Gemini question"]);
  });

  it("lists Grok summaries and combines visible message chunks", async () => {
    const service = localService(createFixture());
    const history = await service.listHistory({ panelSessionId: "run-1", providers: ["grok"], scope: "cwd" });
    expect(history.errors).toEqual([]);
    expect(history.items[0]).toMatchObject({ provider: "grok", title: "Grok title", preview: "Grok summary", cwd: "C:\\work" });

    const detail = await service.getHistoryMessages({ panelSessionId: "run-1", conversationRef: history.items[0].ref });
    expect(detail.messages.map(message => [message.kind, message.text])).toEqual([
      ["reply", "Grok answer"],
      ["user", "Grok question"]
    ]);
  });

  it("rejects forged conversation references", async () => {
    const service = localService(createFixture());
    await expect(service.getHistoryMessages({ panelSessionId: "run-1", conversationRef: "codex:../../secret" })).rejects.toThrow("Invalid Agent conversation reference");
  });

  it("uses the controlled SSH adapter and returns only its normalized response", async () => {
    const exec = vi.fn().mockResolvedValue(JSON.stringify({ items: [], nextCursor: null, errors: [] }));
    const service = createAgentConversationHistoryService({
      terminalManager: { getSession: () => ({ id: "ssh-1", type: "ssh", cwd: "/srv/app" }) },
      sshAgentTransport: { exec }
    });
    await expect(service.listHistory({ panelSessionId: "ssh-1" })).resolves.toEqual({ items: [], nextCursor: null, errors: [] });
    expect(exec).toHaveBeenCalledWith("ssh-1", expect.stringContaining("python3 -c"), expect.objectContaining({ actionName: "Agent conversation history" }));
  });

  it("reads a local-bridge SSH Agent from its Windows runtime workspace", async () => {
    const homeDir = createFixture();
    const exec = vi.fn();
    const service = createAgentConversationHistoryService({
      homeDir,
      terminalManager: { getSession: () => ({ id: "ssh-local", type: "ssh", agentLocation: "local", cwd: "/srv/app", runtimeCwd: "C:\\work" }) },
      sshAgentTransport: { exec }
    });
    const result = await service.listHistory({ panelSessionId: "ssh-local", providers: ["codex"], scope: "cwd" });
    expect(result.items.map(item => item.title)).toEqual(["Codex title"]);
    expect(exec).not.toHaveBeenCalled();
  });
});
