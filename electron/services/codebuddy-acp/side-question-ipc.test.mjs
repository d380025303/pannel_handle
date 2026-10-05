import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { registerIpcHandlers } = require("../../core/ipc-handlers.cjs");
const { createGraphicalSessionRouter } = require("./session-router.cjs");

describe("CodeBuddy side question IPC", () => {
  it("routes ask and cancellation only to CodeBuddy without invoking main submit or interrupt", () => {
    const handlers = new Map();
    const codeBuddy = { askSideQuestion: vi.fn(() => ({ sideQuestion: { status: "running" } })),
      cancelSideQuestion: vi.fn(), submit: vi.fn(), interrupt: vi.fn() };
    const terminalManager = { getSession: id => ({ agentProvider: id === "buddy" ? "codebuddy" : "codex" }) };
    const router = createGraphicalSessionRouter({}, codeBuddy, terminalManager);
    registerIpcHandlers({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: vi.fn() },
      terminalManager, codexAppServerSessionService: router });
    expect(handlers.get("codex-app-server:ask-side-question")({}, "buddy", "question")).toMatchObject({ sideQuestion: { status: "running" } });
    expect(codeBuddy.askSideQuestion).toHaveBeenCalledWith("buddy", "question");
    handlers.get("codex-app-server:cancel-side-question")({}, "buddy", "request");
    expect(codeBuddy.cancelSideQuestion).toHaveBeenCalledWith("buddy", "request");
    expect(() => handlers.get("codex-app-server:ask-side-question")({}, "codex", "question")).toThrow("仅 CodeBuddy");
    expect(codeBuddy.submit).not.toHaveBeenCalled(); expect(codeBuddy.interrupt).not.toHaveBeenCalled();
  });
});
