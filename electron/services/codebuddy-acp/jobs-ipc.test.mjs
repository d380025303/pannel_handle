import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { registerIpcHandlers } = require("../../core/ipc-handlers.cjs");
const { createGraphicalSessionRouter } = require("./session-router.cjs");

describe("CodeBuddy Jobs IPC", () => {
  it("passes only CodeBuddy session requests to the Jobs service", async () => {
    const handlers = new Map();
    const terminalManager = { getSession: id => ({ agentProvider: id === "buddy" ? "codebuddy" : "codex" }) };
    const codeBuddy = { listJobs: vi.fn(() => [{ id: "one" }]), dispatchJob: vi.fn(() => ({ id: "one" })) };
    const router = createGraphicalSessionRouter({}, codeBuddy, terminalManager);
    registerIpcHandlers({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: vi.fn() },
      terminalManager, codexAppServerSessionService: router });
    expect(await handlers.get("codebuddy-jobs:list")({}, "buddy")).toEqual([{ id: "one" }]);
    expect(await handlers.get("codebuddy-jobs:dispatch")({}, "buddy", { prompt: "Check" })).toEqual({ id: "one" });
    expect(codeBuddy.dispatchJob).toHaveBeenCalledWith("buddy", { prompt: "Check" });
    expect(() => handlers.get("codebuddy-jobs:list")({}, "codex")).toThrow("仅 CodeBuddy");
  });
});
