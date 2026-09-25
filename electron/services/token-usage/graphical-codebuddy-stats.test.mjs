import { createRequire } from "node:module";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createTokenUsageModule } = require("./token-usage-module.cjs");
const { createAgentTokenStatsService } = require("./agent-token-stats-service.cjs");

function createIpcMain() {
  const handlers = new Map();
  return { handlers, handle: (channel, handler) => handlers.set(channel, handler),
    on: () => {}, removeHandler: channel => handlers.delete(channel), removeListener: () => {} };
}

function createModule(root, ipcMain, extras = {}) {
  let module;
  module = createTokenUsageModule({ ipcMain, databaseFile: path.join(root, "stats.sqlite3"),
    terminalManager: {}, broadcast: vi.fn(),
    createUsageService: () => ({ disconnect: vi.fn(), shutdown: vi.fn() }),
    createStatsService: options => createAgentTokenStatsService({ ...options, homeDir: root,
      retryDelaysMs: [0], ...extras }),
    onStatsCleared: () => module.resetGraphicalCodeBuddyBaselines() });
  return module;
}

const line = (id, total) => JSON.stringify({ type: "message", providerData: { messageId: id, model: "glm",
  usage: { inputTokens: total, outputTokens: 0, totalTokens: total } } }) + "\n";

describe("graphical CodeBuddy statistics", () => {
  it("counts turns and subagents once, baselines restored threads, and respects clear", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "graphical-codebuddy-"));
    const projects = path.join(root, ".codebuddy", "projects", "workspace");
    mkdirSync(projects, { recursive: true });
    const ipcMain = createIpcMain();
    const module = createModule(root, ipcMain);
    const session = { id: "panel-1", title: "Work", cwd: "C:\\project", type: "windows" };
    const fresh = path.join(projects, "fresh.jsonl");
    const history = path.join(projects, "history.jsonl");
    try {
      writeFileSync(fresh, line("a", 100));
      await module.recordGraphicalCodeBuddy({ threadId: "fresh", session });
      await module.recordGraphicalCodeBuddy({ threadId: "fresh", session });
      expect(module.getDashboard({ range: "all", provider: "codebuddy" }).summary.tokens.totalTokens).toBe(100);
      appendFileSync(fresh, line("b", 30));
      const subagents = path.join(projects, "fresh", "subagents");
      mkdirSync(subagents, { recursive: true });
      writeFileSync(path.join(subagents, "agent-1.jsonl"), line("sub", 40));
      await module.recordGraphicalCodeBuddy({ threadId: "fresh", session });
      expect(module.getDashboard({ range: "all", provider: "codebuddy" }).summary.tokens.totalTokens).toBe(170);
      const graphicalSession = { ...session, runtimeMode: "app-server" };
      module.handleHook({ provider: "codebuddy", session: graphicalSession,
        input: { hook_event_name: "Stop", session_id: "fresh", transcript_path: fresh } });
      await module.recordGraphicalCodeBuddy({ threadId: "fresh", session: graphicalSession });
      expect(module.getDashboard({ range: "all", provider: "codebuddy" }).summary.tokens.totalTokens).toBe(170);

      writeFileSync(history, line("old", 500));
      await module.recordGraphicalCodeBuddy({ threadId: "history", session, resumed: true });
      expect(module.getDashboard({ range: "all", provider: "codebuddy" }).summary.tokens.totalTokens).toBe(170);
      appendFileSync(history, line("new", 30));
      await module.recordGraphicalCodeBuddy({ threadId: "history", session });
      expect(module.getDashboard({ range: "all", provider: "codebuddy" }).summary.tokens.totalTokens).toBe(200);

      ipcMain.handlers.get("agent-token-stats:clear")();
      await module.recordGraphicalCodeBuddy({ threadId: "fresh", session });
      await module.recordGraphicalCodeBuddy({ threadId: "history", session });
      expect(module.getDashboard({ range: "all", provider: "codebuddy" }).summary.tokens.totalTokens).toBe(0);
      appendFileSync(fresh, line("c", 20));
      await module.recordGraphicalCodeBuddy({ threadId: "fresh", session });
      expect(module.getDashboard({ range: "all", provider: "codebuddy" }).summary.tokens.totalTokens).toBe(20);
    } finally { module.shutdown(); rmSync(root, { recursive: true, force: true }); }
  });

  it("reads a remote graphical transcript through SSH", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "graphical-codebuddy-ssh-"));
    const exec = vi.fn(async (_sessionId, command) => command.includes("sid=sys.argv[1]")
      ? JSON.stringify(["/home/user/.codebuddy/projects/work/remote.jsonl"])
      : JSON.stringify([line("remote-1", 15)]));
    const module = createModule(root, createIpcMain(), { sshAgentTransport: { exec } });
    try {
      await module.recordGraphicalCodeBuddy({ threadId: "remote", session: {
        id: "ssh-panel", title: "Remote", cwd: "/work", type: "ssh", agentLocation: "remote" } });
      expect(exec).toHaveBeenCalledTimes(2);
      expect(module.getDashboard({ range: "all", provider: "codebuddy" }).summary.tokens.totalTokens).toBe(15);
    } finally { module.shutdown(); rmSync(root, { recursive: true, force: true }); }
  });
});
