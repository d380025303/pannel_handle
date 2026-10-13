import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const require = createRequire(import.meta.url);
const { createGeminiAcpSessionService, buildInvocation } = require("./session-service.cjs");
const { createGraphicalSessionRouter } = require("../codebuddy-acp/session-router.cjs");

describe("Gemini ACP sessions", () => {
  it.each(["interrupt", "end_turn", "cancelled", "failure", "approve"])("settles pending permissions on %s", async outcome => {
    const requests = [];
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = vi.fn();
    const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
    let promptId;
    child.stdin.on("data", chunk => {
      const message = JSON.parse(String(chunk));
      requests.push(message);
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: { loadSession: true } } });
      if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "thread",
        models: { currentModelId: "auto", availableModels: [{ modelId: "auto", name: "Auto" }] } } });
      if (message.method === "session/set_model" || message.method === "session/load") emit({ id: message.id, result: {} });
      if (message.method === "session/prompt") {
        promptId = message.id;
        emit({ id: 900, method: "session/request_permission", params: { sessionId: "thread",
          toolCall: { toolCallId: "tool", title: "Edit file" }, options: [
            { optionId: "allow", kind: "allow_once", name: "Allow" },
            { optionId: "reject", kind: "reject_once", name: "Reject" }] } });
      }
    });
    const broadcast = vi.fn();
    const service = createGeminiAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast, spawnProcess: () => child,
      historyService: { listHistoryForSession: async () => ({ items: [
        { provider: "gemini", acpSessionId: "saved-thread", title: "Saved", updatedAt: 1000 }
      ], nextCursor: null, errors: [] }) } });
    try {
      await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
      const turn = service.submit("one", "Hello");
      const settled = outcome === "failure" ? expect(turn).rejects.toThrow("prompt failed") : turn;
      await vi.waitFor(() => expect(service.snapshot("one").approvals).toHaveLength(1));
      if (outcome === "interrupt") {
        broadcast.mockClear();
        service.interrupt("one");
        expect(service.snapshot("one").approvals).toEqual([]);
        expect(broadcast).toHaveBeenCalled();
        expect(requests.some(message => message.method === "session/cancel")).toBe(true);
        const count = requests.length;
        expect(() => service.resolveApproval("one", 900, true)).toThrow("确认请求已失效");
        expect(requests).toHaveLength(count);
      } else if (outcome === "approve") service.resolveApproval("one", 900, true);
      emit(outcome === "failure" ? { id: promptId, error: { message: "prompt failed" } }
        : { id: promptId, result: { stopReason: outcome === "interrupt" ? "cancelled" : outcome === "approve" ? "end_turn" : outcome } });
      await settled;
      expect(service.snapshot("one")).toMatchObject({ busy: false, approvals: [] });
      expect(requests.filter(message => message.id === 900 && message.result)).toEqual([
        expect.objectContaining({ result: { outcome: outcome === "approve"
          ? { outcome: "selected", optionId: "allow" } : { outcome: "cancelled" } } })
      ]);
      const count = requests.length;
      expect(() => service.resolveApproval("one", 900, true)).toThrow("确认请求已失效");
      expect(requests).toHaveLength(count);
      await service.setModel("one", "auto");
      await service.listHistory("one");
      await service.resume("one", "saved-thread");
      expect(requests.some(message => message.method === "session/load")).toBe(true);
    } finally { service.shutdown(); }
  });

  it("uses the Gemini ACP command on Windows and WSL", () => {
    expect(buildInvocation({ type: "windows", cwd: "C:\\work", shell: "powershell.exe" }, {}, {}).args.at(-1))
      .toContain("gemini --acp");
    expect(buildInvocation({ type: "wsl", cwd: "/work", wslDistro: "Ubuntu" }, {}, {}).args.at(-1))
      .toContain("exec gemini --acp");
  });

  it("routes Gemini without exposing Codex-only operations", () => {
    const codex = { close: vi.fn(), shutdown: vi.fn() };
    const buddy = { close: vi.fn(), shutdown: vi.fn() };
    const gemini = { snapshot: vi.fn(() => "gemini"), close: vi.fn(), shutdown: vi.fn() };
    const router = createGraphicalSessionRouter(codex, buddy,
      { getSession: () => ({ agentProvider: "gemini" }) }, null, null, null, gemini);
    expect(router.snapshot("one")).toBe("gemini");
    expect(() => router.readAccount("one")).toThrow("仅 Codex");
    router.close("one");
    expect(gemini.close).toHaveBeenCalledWith("one");
  });

  it("handles advertised models, modes, streamed output, and permission choices", async () => {
    const requests = [];
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = vi.fn();
    const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.stdin.on("data", chunk => {
      const message = JSON.parse(String(chunk));
      requests.push(message);
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: { loadSession: true } } });
      if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "gemini-thread",
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] },
        models: { currentModelId: "auto", availableModels: [{ modelId: "auto", name: "Auto" }, { modelId: "pro", name: "Pro" }] }
      } });
      if (message.method === "session/load") emit({ id: message.id, result: {
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] }
      } });
      if (message.method === "session/set_model") emit({ id: message.id, result: {} });
      if (message.method === "session/set_mode") emit({ id: message.id, result: {} });
      if (message.method === "session/prompt") {
        if (message.params.prompt[0]?.text === "fail") {
          emit({ id: message.id, error: { message: "Gemini request failed" } });
          return;
        }
        emit({ method: "session/update", params: { sessionId: "gemini-thread", update: {
          sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } } } });
        emit({ id: message.id, result: { stopReason: "end_turn" } });
      }
    });
    const historyService = { listHistoryForSession: vi.fn(async () => ({ items: [
      { provider: "gemini", acpSessionId: "saved-thread", title: "Saved", updatedAt: 1000 }
    ], nextCursor: null, errors: [] })) };
    const service = createGeminiAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child, historyService });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    expect(service.snapshot("one")).toMatchObject({ provider: "gemini", capabilities: { history: true, plan: true },
      acpOptions: [{ id: "model", currentValue: "auto" }] });
    await service.setModel("one", "pro");
    expect(requests.find(message => message.method === "session/set_model").params)
      .toEqual({ sessionId: "gemini-thread", modelId: "pro" });
    await service.setNativeMode("one", "plan");
    emit({ id: 42, method: "session/request_permission", params: { sessionId: "gemini-thread",
      toolCall: { toolCallId: "tool", title: "Edit file" }, options: [
        { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
        { optionId: "reject", kind: "reject_once", name: "Reject" }] } });
    expect(service.snapshot("one").approvals).toHaveLength(1);
    service.resolveApproval("one", 42, "reject");
    await service.submit("one", "Hello");
    expect(service.snapshot("one").items.some(item => item.text === "Done")).toBe(true);
    await expect(service.submit("one", "fail")).rejects.toThrow("Gemini request failed");
    expect(service.snapshot("one").items.some(item => item.type === "turnError" && item.text === "Gemini request failed")).toBe(true);
    expect((await service.listHistory("one")).data).toMatchObject([{ id: "saved-thread", title: "Saved" }]);
    await service.resume("one", "saved-thread");
    expect(requests.find(message => message.method === "session/load").params.sessionId).toBe("saved-thread");
    service.shutdown();
  });
});
