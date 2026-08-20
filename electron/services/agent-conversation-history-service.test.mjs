import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("rejects forged conversation references", async () => {
    const service = localService(createFixture());
    await expect(service.getHistoryMessages({ panelSessionId: "run-1", conversationRef: "codex:../../secret" })).rejects.toThrow("Invalid Agent conversation reference");
  });

  it("uses the controlled SSH adapter and returns only its normalized response", async () => {
    const exec = vi.fn().mockResolvedValue(JSON.stringify({ items: [], nextCursor: null, errors: [] }));
    const service = createAgentConversationHistoryService({
      terminalManager: { getSession: () => ({ id: "ssh-1", type: "ssh", cwd: "/srv/app" }) },
      sshSessionRuntime: { exec }
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
      sshSessionRuntime: { exec }
    });
    const result = await service.listHistory({ panelSessionId: "ssh-local", providers: ["codex"], scope: "cwd" });
    expect(result.items.map(item => item.title)).toEqual(["Codex title"]);
    expect(exec).not.toHaveBeenCalled();
  });
});
