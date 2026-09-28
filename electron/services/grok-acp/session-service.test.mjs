import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const require = createRequire(import.meta.url);
const { createGrokAcpSessionService, buildInvocation } = require("./session-service.cjs");
const { createGraphicalSessionRouter } = require("../codebuddy-acp/session-router.cjs");

describe("Grok ACP sessions", () => {
  it("uses Grok's stdio ACP command on Windows and WSL", () => {
    expect(buildInvocation({ type: "windows", cwd: "C:\\work", shell: "powershell.exe" }, {}, {}).args.at(-1))
      .toContain("grok agent stdio");
    expect(buildInvocation({ type: "wsl", cwd: "/work", wslDistro: "Ubuntu" }, {}, {}).args.at(-1))
      .toContain("exec grok agent stdio");
  });

  it("routes Grok without exposing Codex-only operations", () => {
    const codex = { close: vi.fn(), shutdown: vi.fn() };
    const buddy = { close: vi.fn(), shutdown: vi.fn() };
    const grok = { snapshot: vi.fn(() => "grok"), close: vi.fn(), shutdown: vi.fn() };
    const router = createGraphicalSessionRouter(codex, buddy,
      { getSession: () => ({ agentProvider: "grok" }) }, null, null, null, null, grok);
    expect(router.snapshot("one")).toBe("grok");
    expect(() => router.readAccount("one")).toThrow("仅 Codex");
    router.close("one");
    expect(grok.close).toHaveBeenCalledWith("one");
  });

  it("uses advertised models and load support while handling output and approvals", async () => {
    const requests = [];
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = vi.fn();
    const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.stdin.on("data", chunk => {
      const message = JSON.parse(String(chunk));
      requests.push(message);
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: { loadSession: true } } });
      if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "grok-thread",
        models: { currentModelId: "build", availableModels: [{ modelId: "build", name: "Grok Build" }, { modelId: "next", name: "Next" }] }
      } });
      if (message.method === "session/load") emit({ id: message.id, result: { sessionId: "saved-thread" } });
      if (message.method === "session/set_model") emit({ id: message.id, result: {} });
      if (message.method === "session/prompt") {
        if (message.params.prompt[0]?.text === "fail") {
          emit({ id: message.id, error: { message: "Grok request failed" } });
          return;
        }
        emit({ method: "session/update", params: { sessionId: "grok-thread", update: {
          sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } } } });
        emit({ id: message.id, result: { stopReason: "end_turn" } });
      }
    });
    const historyService = { listHistoryForSession: vi.fn(async () => ({ items: [
      { provider: "grok", ref: "grok:saved-thread", title: "Saved", updatedAt: 1000 },
      { provider: "grok", ref: "grok:bad:thread", title: "Invalid", updatedAt: 1000 }
    ], nextCursor: null, errors: [] })) };
    const service = createGrokAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child, historyService });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    expect(service.snapshot("one")).toMatchObject({ provider: "grok", capabilities: { history: true, plan: false },
      acpOptions: [{ id: "model", currentValue: "build" }] });
    expect(service.snapshot("one").nativeModes).toEqual([]);
    await service.setModel("one", "next");
    expect(requests.find(message => message.method === "session/set_model").params)
      .toEqual({ sessionId: "grok-thread", modelId: "next" });
    emit({ id: 42, method: "session/request_permission", params: { sessionId: "grok-thread",
      toolCall: { toolCallId: "tool", title: "Edit file" }, options: [
        { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
        { optionId: "reject", kind: "reject_once", name: "Reject" }] } });
    expect(service.snapshot("one").approvals).toHaveLength(1);
    service.resolveApproval("one", 42, "reject");
    await service.submit("one", "Hello");
    expect(service.snapshot("one").items.some(item => item.text === "Done")).toBe(true);
    await expect(service.submit("one", "fail")).rejects.toThrow("Grok request failed");
    expect(service.snapshot("one").items.some(item => item.type === "turnError" && item.text === "Grok request failed")).toBe(true);
    expect((await service.listHistory("one")).data).toMatchObject([{ id: "saved-thread", title: "Saved" }]);
    await service.resume("one", "saved-thread");
    expect(requests.find(message => message.method === "session/load").params.sessionId).toBe("saved-thread");
    service.shutdown();
  });
});
