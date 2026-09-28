import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createTokenUsageModule } = require("./token-usage-module.cjs");
const { createAgentTokenStatsService } = require("./agent-token-stats-service.cjs");
const { parseOpenCodeExport, readOpenCodeExport } = require("./opencode-export.cjs");

function createIpcMain() {
  const handlers = new Map();
  return { handlers, handle: (channel, handler) => handlers.set(channel, handler),
    on: () => {}, removeHandler: channel => handlers.delete(channel), removeListener: () => {} };
}

function createModule(root, readOpenCodeExportFn) {
  const ipcMain = createIpcMain();
  const module = createTokenUsageModule({ ipcMain, databaseFile: path.join(root, "stats.sqlite3"),
    terminalManager: {}, broadcast: vi.fn(),
    createUsageService: () => ({ disconnect: vi.fn(), shutdown: vi.fn() }),
    createStatsService: options => createAgentTokenStatsService({ ...options, readOpenCodeExportFn }),
    onStatsCleared: () => module.resetGraphicalCodeBuddyBaselines() });
  return { module, ipcMain };
}

const usage = (total, models = ["openai/gpt-5"]) => ({ tokens: {
  inputTokens: total, cachedInputTokens: 0, cacheWriteInputTokens: 0,
  outputTokens: 0, reasoningOutputTokens: 0, totalTokens: total }, models });
const session = { id: "panel", title: "OpenCode", cwd: "C:\\project", type: "windows", runtimeMode: "app-server" };

describe("graphical OpenCode statistics", () => {
  it("parses assistant usage once per message and rejects a mismatched export", () => {
    const message = (id, input, output, modelID = "gpt-5") => ({ info: { id, role: "assistant", modelID,
      tokens: { input, output, reasoning: 2, cache: { read: 3, write: 4 } } } });
    const exportData = { info: { id: "thread" }, messages: [
      message("a", 10, 1), message("a", 10, 5), message("b", 20, 6, "gpt-5-mini"),
      { info: { id: "user", role: "user" } }
    ] };
    expect(parseOpenCodeExport(JSON.stringify(exportData), "thread")).toEqual({
      tokens: { inputTokens: 44, cachedInputTokens: 6, cacheWriteInputTokens: 8,
        outputTokens: 11, reasoningOutputTokens: 4, totalTokens: 59 },
      models: ["gpt-5", "gpt-5-mini"]
    });
    expect(() => parseOpenCodeExport(JSON.stringify(exportData), "other")).toThrow("did not match");
  });

  it("reads a remote export with a quoted session ID and working directory", async () => {
    const exec = vi.fn(async () => JSON.stringify({ info: { id: "ses-1" }, messages: [] }));
    await readOpenCodeExport({ threadId: "ses-1", session: { id: "panel", type: "ssh", cwd: "/srv/my project" },
      sshAgentTransport: { exec } });
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0][1]).toContain("opencode session export --sanitize --standalone");
    expect(exec.mock.calls[0][1]).toContain("my project");
    await expect(readOpenCodeExport({ threadId: "bad;id", session: { id: "panel", type: "ssh" },
      sshAgentTransport: { exec } })).rejects.toThrow("Invalid OpenCode session ID");
  });

  it("counts new usage once, baselines a resumed thread, and resets on clear", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "graphical-opencode-"));
    const totals = new Map([["fresh", usage(0)], ["history", usage(500)]]);
    const read = vi.fn(async ({ threadId }) => totals.get(threadId));
    const { module, ipcMain } = createModule(root, read);
    const total = () => module.getDashboard({ range: "all", provider: "opencode" }).summary.tokens.totalTokens;
    try {
      totals.set("fresh", usage(100));
      await module.recordGraphicalOpenCode({ threadId: "fresh", session });
      await module.recordGraphicalOpenCode({ threadId: "fresh", session });
      expect(total()).toBe(100);
      totals.set("fresh", usage(170, ["openai/gpt-5", "openai/gpt-5-mini"]));
      await module.recordGraphicalOpenCode({ threadId: "fresh", session });
      expect(total()).toBe(170);
      expect(module.getDashboard({ range: "all", provider: "opencode" }).sessions[0].models)
        .toEqual(["openai/gpt-5", "openai/gpt-5-mini"]);

      await module.recordGraphicalOpenCode({ threadId: "history", session, resumed: true });
      expect(total()).toBe(170);
      totals.set("history", usage(530));
      await module.recordGraphicalOpenCode({ threadId: "history", session });
      expect(total()).toBe(200);

      ipcMain.handlers.get("agent-token-stats:clear")();
      await module.recordGraphicalOpenCode({ threadId: "fresh", session, baseline: true });
      await module.recordGraphicalOpenCode({ threadId: "history", session, baseline: true });
      expect(total()).toBe(0);
      totals.set("fresh", usage(190));
      await module.recordGraphicalOpenCode({ threadId: "fresh", session });
      expect(total()).toBe(20);
      module.handleHook({ provider: "opencode", session,
        input: { event_name: "message.updated", session_id: "fresh", info: { id: "duplicate",
          role: "assistant", tokens: { input: 999, output: 0 } } } });
      expect(total()).toBe(20);
    } finally { module.shutdown(); rmSync(root, { recursive: true, force: true }); }
  });

  it("discards a collection started before statistics were cleared", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "graphical-opencode-pending-"));
    let finish;
    const read = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const { module, ipcMain } = createModule(root, read);
    try {
      const pending = module.recordGraphicalOpenCode({ threadId: "fresh", session });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      ipcMain.handlers.get("agent-token-stats:clear")();
      finish(usage(100));
      await pending;
      expect(module.getDashboard({ range: "all", provider: "opencode" }).summary.tokens.totalTokens).toBe(0);
    } finally { module.shutdown(); rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps existing totals when an export fails and retries at the next checkpoint", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "graphical-opencode-retry-"));
    const read = vi.fn().mockResolvedValueOnce(usage(40)).mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(usage(75));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { module } = createModule(root, read);
    try {
      await module.recordGraphicalOpenCode({ threadId: "fresh", session });
      await module.recordGraphicalOpenCode({ threadId: "fresh", session });
      expect(module.getDashboard({ range: "all", provider: "opencode" }).summary.tokens.totalTokens).toBe(40);
      await module.recordGraphicalOpenCode({ threadId: "fresh", session });
      expect(module.getDashboard({ range: "all", provider: "opencode" }).summary.tokens.totalTokens).toBe(75);
    } finally { module.shutdown(); error.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });
});
