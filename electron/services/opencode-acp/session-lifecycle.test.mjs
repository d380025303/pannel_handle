import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const require = createRequire(import.meta.url);
const { createOpenCodeAcpSessionService } = require("./session-service.cjs");
const services = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.shutdown())); });

function fixture({ capabilities = { resume: {}, close: {} }, intercept = () => false, directories } = {}) {
  const session = { id: "one", type: "windows", cwd: "C:\\work", shell: "powershell.exe", openCodeAdditionalDirectories: directories };
  const calls = [], children = [], emitters = [];
  const checkpoint = vi.fn();
  const broadcast = vi.fn();
  const service = createOpenCodeAcpSessionService({
    environmentService: { resolve: () => ({}) }, broadcast,
    terminalManager: { getSession: () => session, listSessions: () => [session], broadcastAgentStatus: vi.fn() },
    onTokenUsageCheckpoint: checkpoint,
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
      children.push(child);
      const emit = value => child.stdout.write(JSON.stringify(value) + "\n");
      emitters.push(emit);
      child.stdin.on("data", chunk => {
        const message = JSON.parse(String(chunk)); calls.push(message);
        if (intercept(message, emit)) return;
        const reply = result => emit({ id: message.id, result });
        if (message.method === "initialize") reply({ agentCapabilities: { loadSession: true, sessionCapabilities: capabilities } });
        else if (message.method === "session/new") reply({ sessionId: `active-${children.length}` });
        else if (message.method === "session/list") reply({ sessions: [{ sessionId: "saved", cwd: session.cwd }] });
        else if (message.method === "session/load") {
          update(emit, message.params.sessionId, "saved message"); reply({});
        } else if (message.method === "session/fork") reply({ sessionId: "branch" });
        else if (message.method === "session/resume" || message.method === "session/close") reply({});
        else if (message.method === "session/prompt") reply({ stopReason: "end_turn" });
      });
      return child;
    }
  });
  services.push(service);
  return { service, calls, children, emitters, checkpoint, broadcast, session, start: runtime => service.start(session, runtime) };
}
function update(emit, sessionId, text) {
  emit({ method: "session/update", params: { sessionId, update: {
    sessionUpdate: "agent_message_chunk", messageId: text, content: { type: "text", text }
  } } });
}

describe("OpenCode ACP lifecycle", () => {
  it("resumes a reconnect without replay, preserves the timeline and ignores the old process", async () => {
    const f = fixture(); await f.start();
    update(f.emitters[0], "active-1", "existing answer");
    await f.service.restart("one");
    expect(f.calls.filter(call => call.method === "session/resume")).toHaveLength(1);
    expect(f.calls.some(call => call.method === "session/load")).toBe(false);
    expect(f.calls.find(call => call.method === "session/resume").params).toMatchObject({ sessionId: "active-1", cwd: "C:\\work", mcpServers: [] });
    expect(f.service.snapshot("one").items.map(item => item.text)).toEqual(["existing answer"]);
    update(f.emitters[0], "active-1", "stale answer");
    expect(f.service.snapshot("one").items.map(item => item.text)).toEqual(["existing answer"]);
    expect(f.children[0].kill).toHaveBeenCalledOnce();
    expect(f.checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "active-1", resumed: true }));
    await f.service.submit("one", "continue");
    expect(f.calls.at(-1).method).toBe("session/prompt");
  });

  it.each(["missing capability", "method missing"])("falls back to load on %s without duplicated messages", async reason => {
    const f = fixture({ capabilities: reason === "missing capability" ? {} : { resume: {}, close: {} },
      intercept: (message, emit) => {
        if (message.method !== "session/resume") return false;
        emit({ id: message.id, error: { code: -32601, message: "Method not found" } }); return true;
      } });
    await f.start(); update(f.emitters[0], "active-1", "old message");
    await f.service.restart("one");
    expect(f.calls.filter(call => call.method === "session/load")).toHaveLength(1);
    expect(f.service.snapshot("one").items.map(item => item.text)).toEqual(["saved message"]);
  });

  it("does not fallback on a resume error", async () => {
    const f = fixture({ intercept: (message, emit) => {
      if (message.method !== "session/resume") return false;
      emit({ id: message.id, error: { code: -32603, message: "Recovery failed" } }); return true;
    } });
    await f.start();
    await expect(f.service.restart("one")).rejects.toThrow("Recovery failed");
    expect(f.calls.some(call => call.method === "session/load")).toBe(false);
  });

  it("loads history on initial restoration and closes replaced threads without deleting history", async () => {
    const f = fixture(); await f.start({ resumeThreadId: "saved" });
    expect(f.calls.some(call => call.method === "session/resume")).toBe(false);
    expect(f.service.snapshot("one").items[0].text).toBe("saved message");
    await f.service.newThread("one");
    expect(f.calls.at(-1)).toMatchObject({ method: "session/close", params: { sessionId: "saved" } });
    await f.service.listHistory("one");
    await f.service.resume("one", "saved");
    expect(f.calls.at(-1)).toMatchObject({ method: "session/close", params: { sessionId: "active-1" } });
    expect(f.calls.some(call => call.method === "session/delete")).toBe(false);
  });

  it("shares repeated close and keeps the process alive until acknowledgement", async () => {
    let acknowledge;
    const f = fixture({ intercept: (message, emit) => {
      if (message.method !== "session/close") return false;
      acknowledge = () => emit({ id: message.id, result: {} }); return true;
    } });
    await f.start();
    const closing = f.service.close("one");
    expect(f.service.close("one")).toBe(closing);
    expect(f.children[0].kill).not.toHaveBeenCalled();
    acknowledge(); await closing;
    expect(f.children[0].kill).toHaveBeenCalledOnce();
    expect(f.calls.filter(call => call.method === "session/close")).toHaveLength(1);
  });

  it("waits for protocol close before spawning the reconnect process", async () => {
    let acknowledge;
    const f = fixture({ intercept: (message, emit) => {
      if (message.method !== "session/close") return false;
      acknowledge = () => emit({ id: message.id, result: {} }); return true;
    } }); await f.start();
    const reconnect = f.service.restart("one");
    expect(f.children).toHaveLength(1);
    acknowledge(); await reconnect;
    expect(f.children).toHaveLength(2);
    const closed = f.service.close("one"); acknowledge(); await closed;
  });

  it("keeps the previous thread and timeline when history loading fails", async () => {
    const f = fixture({ intercept: (message, emit) => {
      if (message.method !== "session/load") return false;
      emit({ id: message.id, error: { code: -32603, message: "Load failed" } }); return true;
    } }); await f.start(); update(f.emitters[0], "active-1", "current answer");
    await f.service.listHistory("one");
    await expect(f.service.resume("one", "saved")).rejects.toThrow("Load failed");
    expect(f.service.snapshot("one")).toMatchObject({ threadId: "active-1", items: [{ text: "current answer" }] });
    expect(f.calls.some(call => call.method === "session/close")).toBe(false);
  });

  it("forces cleanup after the three second close timeout", async () => {
    const f = fixture({ intercept: message => message.method === "session/close" }); await f.start();
    vi.useFakeTimers();
    try {
      const closing = f.service.close("one");
      await vi.advanceTimersByTimeAsync(3000); await closing;
      expect(f.children[0].kill).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it.each(["error", "exit"])("cleans up after close %s", async reason => {
    const f = fixture({ intercept: (message, emit) => {
      if (message.method !== "session/close") return false;
      if (reason === "error") emit({ id: message.id, error: { code: -32000, message: "Close failed" } });
      return true;
    } }); await f.start();
    const closing = f.service.close("one");
    if (reason === "exit") f.children[0].emit("exit", 0);
    await closing;
    expect(f.children[0].kill).toHaveBeenCalledOnce();
  });

  it("closes during a prompt without publishing its late completion", async () => {
    let complete;
    const f = fixture({ intercept: (message, emit) => {
      if (message.method !== "session/prompt") return false;
      complete = () => emit({ id: message.id, result: { stopReason: "cancelled" } }); return true;
    } }); await f.start();
    const prompt = f.service.submit("one", "work");
    const observed = prompt.catch(() => {});
    const count = f.broadcast.mock.calls.length;
    const closing = f.service.close("one"); complete();
    await closing; await observed;
    expect(f.broadcast).toHaveBeenCalledTimes(count);
  });
});


describe("OpenCode additional directory requests", () => {
  it("replaces grants on new, load, resume and fork using the current configuration", async () => {
    const f = fixture({ capabilities: { additionalDirectories: {}, resume: {}, close: {}, fork: {} }, directories: ["C:\\shared"] });
    await f.start();
    expect(f.calls.find(call => call.method === "session/new").params).toMatchObject({ cwd: "C:\\work", additionalDirectories: ["C:\\shared"], mcpServers: [] });
    await f.service.listHistory("one");
    f.session.openCodeAdditionalDirectories = ["C:\\next"];
    await f.service.resume("one", "saved");
    expect(f.calls.find(call => call.method === "session/load").params.additionalDirectories).toEqual(["C:\\next"]);
    await f.service.restart("one");
    expect(f.calls.find(call => call.method === "session/resume").params.additionalDirectories).toEqual(["C:\\next"]);
    await f.service.listHistory("one");
    f.session.openCodeAdditionalDirectories = [];
    await f.service.forkThread("one", "saved");
    expect(f.calls.find(call => call.method === "session/fork").params.additionalDirectories).toEqual([]);
    await f.service.newThread("one");
    expect(f.calls.filter(call => call.method === "session/new").at(-1).params.additionalDirectories).toEqual([]);
  });
  it("sends an explicit empty list for supported Agents with no saved configuration", async () => {
    const f = fixture({ capabilities: { additionalDirectories: {} } });
    await f.start({ resumeThreadId: "saved" });
    expect(f.calls.find(call => call.method === "session/load").params.additionalDirectories).toEqual([]);
  });
  it("keeps older Agents compatible with empty configuration", async () => {
    const f = fixture(); await f.start();
    expect(f.calls.find(call => call.method === "session/new").params).not.toHaveProperty("additionalDirectories");
    f.session.openCodeAdditionalDirectories = ["C:\\shared"];
    await expect(f.service.newThread("one")).rejects.toThrow("不支持额外目录授权");
    expect(f.service.snapshot("one").threadId).toBe("active-1");
  });
  it("fails before session creation when configured grants are unsupported", async () => {
    const f = fixture({ directories: ["C:\\shared"] });
    await expect(f.start()).rejects.toThrow("不支持额外目录授权");
    expect(f.calls.some(call => call.method === "session/new")).toBe(false);
  });
});
