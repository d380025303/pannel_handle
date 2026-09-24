import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createDiagnosticsStore } = require("./diagnostics-store.cjs");
const { createCodexAppServerSessionService } = require("./session-service.cjs");

function fakeProcess({ earlyWarning = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit("exit", 0);
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = JSON.parse(line);
      if (request.id == null) continue;
      if (earlyWarning && request.method === "initialize") child.emitNotification("configWarning", {
        summary: "配置项已忽略", details: "检查 config.toml", path: "C:\\project\\.codex\\config.toml"
      });
      const result = request.method === "thread/start" ? { thread: { id: "thread-1", model: "test-model", status: { type: "idle" } } }
        : request.method === "thread/read" ? { thread: { id: request.params.threadId, cwd: "C:\\project" } }
          : request.method === "thread/resume" ? { thread: { id: request.params.threadId, model: "test-model", turns: [] } }
            : request.method === "model/list" ? { data: [{ id: "test-model", isDefault: true }] } : {};
      child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  });
  child.emitNotification = (method, params) => child.stdout.write(`${JSON.stringify({ method, params })}\n`);
  return child;
}

describe("Codex App Server diagnostics", () => {
  it("archives initialization warnings after the thread is known and ignores other threads", async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-codex-warning-"));
    const store = createDiagnosticsStore({ userData });
    const child = fakeProcess({ earlyWarning: true });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {},
      spawnProcess: () => child, diagnosticsStore: store });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      expect(service.snapshot("run-1").diagnostics).toMatchObject([{ kind: "configWarning", payload: { summary: "配置项已忽略" } }]);
      child.emitNotification("turn/diff/updated", { threadId: "other-thread", turnId: "turn-x", diff: "wrong" });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(service.snapshot("run-1").turnDiffs).toEqual([]);
      expect(store.list("thread-1").events).toHaveLength(1);
    } finally { service.close("run-1"); store.close(); fs.rmSync(userData, { recursive: true, force: true }); }
  });

  it("persists full hook runs, categorized errors, and only the latest diff per turn", async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-codex-diagnostics-"));
    const store = createDiagnosticsStore({ userData });
    const child = fakeProcess();
    const statuses = [];
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: value => statuses.push(value) }, broadcast: () => {},
      spawnProcess: () => child, diagnosticsStore: store });
    const emit = (method, params = {}) => child.emitNotification(method, { threadId: "thread-1", ...params });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      emit("turn/started", { turn: { id: "turn-1", status: "inProgress" } });
      emit("thread/status/changed", { status: { type: "active", activeFlags: ["waitingOnApproval"] } });
      emit("hook/started", { turnId: "turn-1", run: { name: "PreToolUse", input: { secret: "full detail" } } });
      emit("model/rerouted", { turnId: "turn-1", fromModel: "test-model", toModel: "fallback", reason: "capacity" });
      emit("turn/diff/updated", { turnId: "turn-1", diff: "old diff" });
      emit("turn/diff/updated", { turnId: "turn-1", diff: "new diff" });
      emit("error", { turnId: "turn-1", error: { message: "limit", codexErrorInfo: { type: "UsageLimitExceeded", httpStatusCode: 429 }, additionalDetails: "try later" } });
      emit("turn/completed", { turn: { id: "turn-1", status: "failed" } });
      await vi.waitFor(() => expect(service.snapshot("run-1").turnStatus).toBe("failed"));
      expect(service.snapshot("run-1")).toMatchObject({ threadStatus: { type: "active", activeFlags: ["waitingOnApproval"] },
        effectiveModel: "fallback", errorDetails: { kind: "UsageLimitExceeded", httpStatusCode: 429 },
        turnDiffs: [{ turnId: "turn-1", diff: "new diff" }] });
      expect(statuses.at(-1).status).toBe("failed");
      expect(store.list("thread-1").events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "hook/started", payload: expect.objectContaining({ run: { name: "PreToolUse", input: { secret: "full detail" } } }) })
      ]));
      expect(store.list("thread-1").diffs).toHaveLength(1);
      service.close("run-1");
      store.close();
      const reopened = createDiagnosticsStore({ userData });
      expect(reopened.list("thread-1").diffs[0].diff).toBe("new diff");
      expect(reopened.list("thread-1").events.some(event => event.kind === "error" && event.payload.kind === "UsageLimitExceeded")).toBe(true);
      const restored = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
        terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {},
        spawnProcess: () => fakeProcess(), diagnosticsStore: reopened });
      try {
        await restored.start({ id: "run-2", type: "windows", shell: "cmd.exe", cwd: "C:\\project" }, { resumeThreadId: "thread-1" });
        expect(restored.snapshot("run-2").turnDiffs).toMatchObject([{ turnId: "turn-1", diff: "new diff" }]);
        expect(restored.snapshot("run-2").diagnostics.some(event => event.kind === "hook/started")).toBe(true);
      } finally { restored.close("run-2"); }
      reopened.close();
    } finally {
      service.close("run-1");
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });
});
