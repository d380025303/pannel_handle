import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const require = createRequire(import.meta.url);
const { createOpenCodeAcpSessionService } = require("./session-service.cjs");
const { createGraphicalSessionRouter } = require("../codebuddy-acp/session-router.cjs");
const services = [];
afterEach(() => { for (const service of services.splice(0)) service.shutdown(); });

function fixture({ capabilities = { fork: {}, delete: {} }, intercept = () => false, runtime = {} } = {}) {
  const calls = [];
  const rows = [{ sessionId: "history", cwd: "C:\\work" }, { sessionId: "active", cwd: "C:\\work" }];
  const checkpoint = vi.fn();
  const broadcast = vi.fn();
  let next = 0;
  const service = createOpenCodeAcpSessionService({
    environmentService: { resolve: () => ({}) }, terminalManager: { broadcastAgentStatus: vi.fn() },
    broadcast, onTokenUsageCheckpoint: checkpoint,
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
      const emit = value => child.stdout.write(JSON.stringify(value) + "\n");
      child.stdin.on("data", chunk => {
        const message = JSON.parse(String(chunk)); calls.push(message);
        if (intercept(message, emit)) return;
        const reply = result => emit({ id: message.id, result });
        if (message.method === "initialize") reply({ agentCapabilities: { loadSession: true, sessionCapabilities: capabilities } });
        else if (message.method === "session/new") reply({ sessionId: ++next === 1 ? "active" : `active-${next}` });
        else if (message.method === "session/list") reply({ sessions: [...rows] });
        else if (message.method === "session/load") reply({ sessionId: message.params.sessionId });
        else if (message.method === "session/fork") {
          for (const [sessionUpdate, text] of [["user_message_chunk", "original prompt"], ["agent_message_chunk", "original answer"]])
            emit({ method: "session/update", params: { sessionId: "branch", update: { sessionUpdate, content: { type: "text", text } } } });
          emit({ method: "session/update", params: { sessionId: "branch", update: {
            sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact" }] } } });
          rows.push({ sessionId: "branch", cwd: "C:\\work" });
          reply({ sessionId: "branch", configOptions: [{ id: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "Build" }] }] });
        } else if (message.method === "session/delete") {
          rows.splice(rows.findIndex(value => value.sessionId === message.params.sessionId), 1); reply({});
        } else if (message.method === "session/prompt") reply({ stopReason: "end_turn" });
      });
      return child;
    }
  });
  services.push(service);
  const start = async (id = "one", options = runtime) => {
    await service.start({ id, type: "windows", cwd: "C:\\work", shell: "powershell.exe" }, options);
    await service.listHistory(id);
  };
  return { service, start, calls, rows, checkpoint, broadcast };
}

describe("OpenCode graphical history actions", () => {
  it("forks with native ACP context, retains early replay, establishes usage baseline, and leaves source intact", async () => {
    const f = fixture();
    await f.start();
    const next = await f.service.forkThread("one", "history");
    expect(next).toMatchObject({ threadId: "branch", busy: false, nativeMode: "build", capabilities: { forkHistory: true, deleteHistory: true } });
    expect(next.items.map(item => item.text)).toEqual(["original prompt", "original answer"]);
    expect(next.availableCommands).toEqual([{ name: "compact", description: "" }]);
    expect(f.calls.find(value => value.method === "session/fork").params).toMatchObject({ sessionId: "history", cwd: "C:\\work",
      mcpServers: [] });
    expect(f.checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "branch", resumed: true }));
    expect((await f.service.listHistory("one")).data.map(row => row.id)).toContain("history");
    await f.service.submit("one", "continue");
    expect(f.calls.at(-1).params.sessionId).toBe("branch");
  });

  it("deletes only a listed inactive target and removes it from subsequent history", async () => {
    const f = fixture(); await f.start();
    await f.service.deleteThread("one", "history");
    expect(f.calls.find(value => value.method === "session/delete").params).toEqual({ sessionId: "history" });
    expect((await f.service.listHistory("one")).data.map(row => row.id)).not.toContain("history");
    expect(f.service.snapshot("one")).toMatchObject({ threadId: "active", busy: false });
    await expect(f.service.deleteThread("one", "history")).rejects.toThrow("当前项目");
  });

  it("rejects deleting the current thread or a thread open in another panel", async () => {
    const f = fixture(); await f.start(); await f.start("two");
    await f.service.resume("two", "history");
    await expect(f.service.deleteThread("one", "history")).rejects.toThrow("仍在本应用中打开");
    await expect(f.service.deleteThread("one", "active")).rejects.toThrow("仍在本应用中打开");
    expect(f.calls.some(value => value.method === "session/delete")).toBe(false);
  });

  it("gates absent/null capabilities and revalidates stale project membership", async () => {
    const missing = fixture({ capabilities: { fork: null } }); await missing.start();
    expect(missing.service.snapshot("one").capabilities).toMatchObject({ forkHistory: false, deleteHistory: false });
    await expect(missing.service.forkThread("one", "history")).rejects.toThrow("不支持分叉");
    await expect(missing.service.deleteThread("one", "history")).rejects.toThrow("不支持删除");
    const f = fixture(); await f.start();
    await expect(f.service.forkThread("one", "unlisted")).rejects.toThrow("当前项目");
    f.rows[0].cwd = "C:\\other";
    await expect(f.service.deleteThread("one", "history")).rejects.toThrow("不属于当前项目");
    expect(f.calls.some(value => value.method === "session/delete")).toBe(false);
  });

  it("retains the previous conversation on fork errors including replay preceding an error", async () => {
    const f = fixture({ intercept: (message, emit) => {
      if (message.method !== "session/fork") return false;
      emit({ method: "session/update", params: { sessionId: "failed-branch", update: { sessionUpdate: "agent_message_chunk", content: { text: "discard" } } } });
      emit({ id: message.id, error: { message: "fork failed" } }); return true;
    } });
    await f.start(); await f.service.submit("one", "keep original");
    const before = f.service.snapshot("one");
    await expect(f.service.forkThread("one", "history")).rejects.toThrow("fork failed");
    expect(f.service.snapshot("one")).toEqual(before);
  });

  it("keeps failed deletions in history and unlocks for retry", async () => {
    let fail = true;
    const f = fixture({ intercept: (message, emit) => {
      if (message.method !== "session/delete" || !fail) return false;
      emit({ id: message.id, error: { message: "delete failed" } }); return true;
    } });
    await f.start(); await expect(f.service.deleteThread("one", "history")).rejects.toThrow("delete failed");
    expect((await f.service.listHistory("one")).data.map(row => row.id)).toContain("history");
    fail = false; await f.service.deleteThread("one", "history");
  });

  it("reserves deletion targets across panels and blocks sending/switching during a mutation", async () => {
    let release;
    const f = fixture({ intercept: (message, emit) => {
      if (message.method !== "session/delete") return false;
      release = () => emit({ id: message.id, result: {} }); return true;
    } });
    await f.start(); await f.start("two");
    const pending = f.service.deleteThread("one", "history");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(f.service.snapshot("one").busy).toBe(true);
    await expect(f.service.resume("two", "history")).rejects.toThrow("正在进行");
    await expect(f.service.forkThread("two", "history")).rejects.toThrow("正在进行");
    await expect(f.service.submit("one", "blocked")).rejects.toThrow("正在进行");
    await expect(f.service.newThread("one")).rejects.toThrow("正在进行");
    await expect(f.start("three", { resumeThreadId: "history" })).rejects.toThrow("正在进行");
    release(); await pending;
    expect(f.service.snapshot("one").busy).toBe(false);
  });

  it("reserves a source while another panel is submitting", async () => {
    let release;
    const f = fixture({ intercept: (message, emit) => {
      if (message.method !== "session/prompt") return false;
      release = () => emit({ id: message.id, result: {} }); return true;
    } });
    await f.start(); await f.start("two");
    const pending = f.service.submit("one", "running");
    await expect(f.service.forkThread("two", "active")).rejects.toThrow("正在进行");
    release(); await pending;
  });

  it("routes OpenCode history actions while preserving Codex fork arguments", () => {
    const codex = { forkThread: vi.fn() }, openCode = { forkThread: vi.fn(), deleteThread: vi.fn() };
    const router = createGraphicalSessionRouter(codex, {}, { getSession: id => ({ agentProvider: id }) }, openCode);
    router.forkThread("codex", "source", "turn"); router.forkThread("opencode", "source"); router.deleteThread("opencode", "source");
    expect(codex.forkThread).toHaveBeenCalledWith("codex", "source", "turn");
    expect(openCode.deleteThread).toHaveBeenCalledWith("opencode", "source");
    expect(() => router.deleteThread("codex", "source")).toThrow("不支持");
  });
});
