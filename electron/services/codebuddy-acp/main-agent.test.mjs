import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
const require = createRequire(import.meta.url);
const { createCodeBuddyAcpSessionService } = require("./session-service.cjs");
const { createGraphicalSessionRouter } = require("./session-router.cjs");
const { registerIpcHandlers } = require("../../core/ipc-handlers.cjs");

function fixture({ support = true, mode = "default", multitask = false, runtime = {} } = {}) {
  const events = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const state = { current: "cli", blank: true, failure: null, setWait: null, requests: [], thread: 0 };
  const agents = [{ name: "cli", displayName: "标准", source: "built-in" }, { name: "minimal", displayName: "极简" },
    { name: "reviewer", displayName: "审查员", source: "project" }, { name: "multitask", displayName: "Multitask" }, { name: "broken", displayName: "损坏", broken: "配置错误" }];
  const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
    terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child,
    historyService: { listHistoryForSession: async () => ({ items: [{ provider: "codebuddy", ref: "codebuddy:history", cwd: "C:\\work" }] }) },
    resolveHttpEndpoint: async () => ({ endpoint: new URL("http://127.0.0.1:12345"), password: "test" }),
    httpTransportFactory: () => ({ on: (...args) => events.on(...args), connect: async () => {}, close: () => {}, send: async message => {
      state.requests.push(message);
      let result = {};
      if (message.method === "initialize") result = { agentCapabilities: { mainAgentSupport: support, loadSession: true } };
      if (message.method === "session/new" || message.method === "session/load") {
        state.blank = message.method === "session/new";
        result = { sessionId: message.params.sessionId || `thread-${++state.thread}`, modes: { currentModeId: mode, availableModes: [{ id: mode }] },
          configOptions: [{ id: "model", type: "select", currentValue: "old", options: [{ value: "old", name: "Old" }] },
            { id: "multitask", type: "boolean", currentValue: multitask }] };
      }
      if (message.method === "_codebuddy.ai/getAgents") {
        if (state.failure) { events.emit("message", { id: message.id, error: state.failure }); return; }
        result = { currentAgentName: state.current, sessionBlank: state.blank, agents };
      }
      if (message.method === "session/set_agent") {
        if (state.setWait) await state.setWait;
        state.current = message.params.agentName;
        result = { agentName: state.current, currentModelId: "new", models: [{ modelId: "new", name: "New" }] };
      }
      if (message.method === "session/prompt") { state.blank = false; result = { stopReason: "end_turn" }; }
      events.emit("message", { id: message.id, result });
    } }) });
  return { service, state, start: () => service.start({ id: "one", type: "windows", cwd: "C:\\work" }, runtime) };
}

describe("CodeBuddy main agent selection", () => {
  it("routes main-agent IPC only to a provider implementing the operation", () => {
    const handlers = new Map();
    const buddy = { listMainAgents: vi.fn(() => "list"), setMainAgent: vi.fn(() => "selected") };
    const terminalManager = { getSession: id => ({ agentProvider: id === "buddy" ? "codebuddy" : "codex" }) };
    const router = createGraphicalSessionRouter({}, buddy, terminalManager);
    registerIpcHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: vi.fn() },
      terminalManager, codexAppServerSessionService: router });
    expect(handlers.get("codex-app-server:main-agents")({}, "buddy")).toBe("list");
    expect(handlers.get("codex-app-server:main-agent")({}, "buddy", "reviewer")).toBe("selected");
    expect(buddy.setMainAgent).toHaveBeenCalledWith("buddy", "reviewer");
    expect(() => handlers.get("codex-app-server:main-agent")({}, "codex", "reviewer")).toThrow("不支持");
  });
  it("negotiates, reads custom agents, switches without sending a prompt and reconciles the model", async () => {
    const { service, state, start } = fixture();
    try {
      await start();
      expect(state.requests[0].params.clientCapabilities._meta["codebuddy.ai"].mainAgentSupport).toBe(true);
      expect(service.snapshot("one").mainAgent.agents).toContainEqual(expect.objectContaining({ name: "reviewer", source: "project" }));
      expect(service.snapshot("one").mainAgent.agents.some(agent => agent.name === "multitask")).toBe(false);
      const next = await service.setMainAgent("one", "reviewer");
      expect(next.mainAgent).toMatchObject({ currentAgentName: "reviewer", sessionBlank: true, changing: false });
      expect(next.acpOptions.find(option => option.id === "model")).toMatchObject({ currentValue: "new", options: [{ value: "new", name: "New" }] });
      expect(state.requests.filter(request => request.method === "session/set_agent")[0].params).toEqual({ sessionId: "thread-1", agentName: "reviewer" });
      expect(state.requests.some(request => request.method === "session/prompt")).toBe(false);
      await service.submit("one", "hello");
      await expect(service.setMainAgent("one", "cli")).rejects.toThrow("新建对话");
      expect((await service.newThread("one")).mainAgent).toMatchObject({ currentAgentName: "reviewer", sessionBlank: true });
      await service.listHistory("one");
      expect((await service.resume("one", "history")).mainAgent.sessionBlank).toBe(false);
    } finally { service.shutdown(); }
  });

  it("blocks submit, duplicate changes and history switches while changing", async () => {
    const { service, state, start } = fixture();
    let release;
    try {
      await start();
      state.setWait = new Promise(resolve => { release = resolve; });
      const pending = service.setMainAgent("one", "reviewer");
      await vi.waitFor(() => expect(state.requests.some(request => request.method === "session/set_agent")).toBe(true));
      expect(service.snapshot("one").busy).toBe(true);
      await expect(service.submit("one", "hello")).rejects.toThrow("正在切换");
      await expect(service.newThread("one")).rejects.toThrow("正在切换");
      await expect(service.setMainAgent("one", "cli")).rejects.toThrow("操作正在进行");
      release(); await pending;
      expect(service.snapshot("one").busy).toBe(false);
    } finally { release?.(); service.shutdown(); }
  });

  it.each([{ mode: "plan" }, { multitask: true }])("rejects incompatible minimal mode: %j", async options => {
    const { service, start, state } = fixture(options);
    try {
      await start();
      await expect(service.setMainAgent("one", "minimal")).rejects.toThrow("不能与 Plan 或 Multitask");
      await expect(service.setMainAgent("one", "missing")).rejects.toThrow("不可用");
      await expect(service.setMainAgent("one", "broken")).rejects.toThrow("配置错误");
      expect(state.requests.some(request => request.method === "session/set_agent")).toBe(false);
    } finally { service.shutdown(); }
  });

  it("keeps ordinary sessions usable when discovery fails and supports retry", async () => {
    const { service, state, start } = fixture();
    try {
      state.failure = { code: -1, message: "temporarily unavailable" };
      await start();
      expect(service.snapshot("one").mainAgent.error).toBe("temporarily unavailable");
      state.failure = null;
      expect((await service.listMainAgents("one")).mainAgent).toMatchObject({ error: null, sessionBlank: true });
      state.failure = { code: -32601, message: "method not found" };
      expect((await service.listMainAgents("one")).mainAgent).toBeNull();
      await service.submit("one", "hello");
    } finally { service.shutdown(); }
  });

  it.each([{ support: false }, { runtime: { localBridge: true } }])("does not enable unsupported or restricted sessions: %j", async options => {
    const { service, state, start } = fixture(options);
    try {
      await start();
      expect(service.snapshot("one").mainAgent).toBeNull();
      expect(state.requests.some(request => request.method === "_codebuddy.ai/getAgents")).toBe(false);
      await expect(service.setMainAgent("one", "cli")).rejects.toThrow("不支持");
    } finally { service.shutdown(); }
  });
});
