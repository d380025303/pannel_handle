import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createAgentTokenStatsService } = require("./agent-token-stats-service.cjs");
const { createAgentConversationManager } = require("../../core/agent-conversation-manager.cjs");

function message(provider, id, text) {
  return JSON.stringify(provider === "codex"
    ? { type: "response_item", payload: { type: "message", id, role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] } }
    : { type: "message", role: "assistant", providerData: { messageId: id }, content: [{ type: "text", text }] }) + "\n";
}

function harness(provider) {
  const pathname = "/srv/session.jsonl";
  let bytes = Buffer.from(message(provider, "old", "历史消息"));
  let identity = "1:1";
  let gate = null;
  let fail = false;
  const intervals = new Set();
  const broadcasts = [];
  const manager = createAgentConversationManager({ broadcast: (channel, snapshot) => broadcasts.push({ channel, snapshot }) });
  manager.setActiveSession("remote");
  const clients = [];
  const transport = {
    exec: vi.fn(async () => "[]"),
    createReusableCommandClient: vi.fn(() => {
      const client = {
        close: vi.fn(),
        exec: vi.fn(async command => {
          const state = JSON.parse(command.match(/ '(\{.*\})' \d+ /)[1])[pathname];
          const start = state.identity === identity && state.offset <= bytes.length ? state.offset : 0;
          const result = JSON.stringify({ main: { path: pathname, identity, start, offset: bytes.length, data: bytes.subarray(start).toString("base64") }, subagents: [] });
          const pending = gate;
          gate = null;
          if (pending) await pending;
          if (fail) { fail = false; throw new Error("disconnected"); }
          return result;
        })
      };
      clients.push(client);
      return client;
    })
  };
  const service = createAgentTokenStatsService({
    terminalManager: {}, sshAgentTransport: transport, conversationSink: manager,
    statsStore: { setBaseline: vi.fn(), update: vi.fn(value => value), markEnded: vi.fn() },
    retryDelaysMs: [0],
    setIntervalFn: callback => { intervals.add(callback); return callback; },
    clearIntervalFn: callback => intervals.delete(callback)
  });
  const session = { id: "remote", type: "ssh", agentLocation: "remote", agentProvider: provider, title: provider, cwd: "/srv" };
  const hook = (event, extra = {}) => service.handleHook({ provider, session, input: { session_id: "agent", transcript_path: pathname, hook_event_name: event, ...extra } });
  return {
    service, manager, clients, intervals, broadcasts, hook, transport,
    append: value => { bytes = Buffer.concat([bytes, Buffer.from(value)]); },
    replace: value => { bytes = Buffer.from(value); identity += "x"; },
    truncate: value => { bytes = Buffer.from(value); },
    disconnect: () => { fail = true; },
    hold: () => { let release; gate = new Promise(resolve => { release = resolve; }); return release; },
    tick: async (wait = true) => {
      const requests = [...intervals].map(callback => callback());
      if (wait) await Promise.all(requests);
      await new Promise(resolve => setImmediate(resolve));
    },
    messages: () => manager.getSnapshot().turn?.messages || [],
    start: async () => {
      hook("SessionStart");
      await new Promise(resolve => setImmediate(resolve));
      hook("UserPromptSubmit", { prompt: "检查项目", event_id: "prompt-1" });
      await vi.waitFor(() => expect(intervals.size).toBe(1));
    }
  };
}

describe.each(["codex", "codebuddy"])("remote %s conversation", provider => {
  it("publishes message-only deltas, buffers split Chinese bytes, and flushes Stop without duplicates", async () => {
    const h = harness(provider);
    try {
      await h.start();
      expect(h.messages().map(item => item.text)).toEqual(["检查项目"]);
      const row = Buffer.from(message(provider, "live", "中文实时回复"));
      const split = row.indexOf(Buffer.from("中")) + 1;
      h.append(row.subarray(0, split));
      await h.tick();
      expect(h.messages()).toHaveLength(1);
      h.append(row.subarray(split));
      await h.tick();
      expect(h.messages().map(item => item.text)).toEqual(["检查项目", "中文实时回复"]);
      expect(h.manager.getSnapshot().turn.status).toBe("running");
      await h.tick();
      expect(h.messages()).toHaveLength(2);
      h.append(message(provider, "last", "收尾回复").trimEnd());
      h.hook("Stop", { last_assistant_message: "收尾回复" });
      await vi.waitFor(() => expect(h.manager.getSnapshot().turn.status).toBe("completed"));
      expect(h.messages().map(item => item.text)).toEqual(["检查项目", "中文实时回复", "收尾回复"]);
      expect(h.clients[0].close).toHaveBeenCalledOnce();
      expect(h.intervals.size).toBe(0);
      h.hook("UserPromptSubmit", { prompt: "下一轮", event_id: "prompt-2" });
      await vi.waitFor(() => expect(h.intervals.size).toBe(1));
      h.append("\n" + message(provider, "next", "下一轮回复"));
      await h.tick();
      expect(h.messages().map(item => item.text)).toEqual(["检查项目", "中文实时回复", "收尾回复", "下一轮", "下一轮回复"]);
    } finally { h.service.shutdown(); }
  });

  it("recovers after disconnect and file replacement without duplicating displayed messages", async () => {
    const h = harness(provider);
    try {
      await h.start();
      const row = message(provider, "one", "第一条");
      h.append(row);
      await h.tick();
      h.disconnect();
      await h.tick();
      expect(h.service.getLive("remote").state).toBe("unavailable");
      h.append(message(provider, "two", "第二条"));
      await h.tick();
      expect(h.clients).toHaveLength(2);
      h.replace(row + message(provider, "three", "替换后消息"));
      await h.tick();
      expect(h.messages().map(item => item.text)).toEqual(["检查项目", "第一条", "第二条", "替换后消息"]);
      h.truncate(message(provider, "four", "截断后"));
      await h.tick();
      expect(h.messages().at(-1).text).toBe("截断后");
    } finally { h.service.shutdown(); }
  });

  it.each(["end", "shutdown"])("discards in-flight reads on %s", async action => {
    const h = harness(provider);
    await h.start();
    const release = h.hold();
    h.append(message(provider, "late", "不应出现"));
    await h.tick(false);
    if (action === "end") h.service.markEnded("remote");
    else h.service.shutdown();
    const count = h.broadcasts.length;
    release();
    await new Promise(resolve => setImmediate(resolve));
    expect(h.broadcasts).toHaveLength(count);
    expect(h.intervals.size).toBe(0);
    expect(h.service.getLive("remote")).toBeNull();
    expect(h.clients[0].close).toHaveBeenCalledOnce();
  });

  it("reads a final delta when Stop arrives during a poll", async () => {
    const h = harness(provider);
    try {
      await h.start();
      const release = h.hold();
      await h.tick(false);
      h.append(message(provider, "last", "停止前写入"));
      h.hook("Stop");
      release();
      await vi.waitFor(() => expect(h.manager.getSnapshot().turn.status).toBe("completed"));
      expect(h.messages().at(-1).text).toBe("停止前写入");
      expect(h.intervals.size).toBe(0);
    } finally { h.service.shutdown(); }
  });

  it("does not restart polling when closed during turn initialization", async () => {
    const h = harness(provider);
    const release = h.hold();
    h.hook("UserPromptSubmit", { prompt: "立即关闭" });
    h.service.markEnded("remote");
    release();
    await new Promise(resolve => setImmediate(resolve));
    expect(h.intervals.size).toBe(0);
    expect(h.service.getLive("remote")).toBeNull();
    expect(h.manager.getSnapshot().turn).toBeNull();
  });

  it("does not complete a new turn when an older Stop read finishes", async () => {
    const h = harness(provider);
    try {
      await h.start();
      const release = h.hold();
      h.hook("Stop");
      h.hook("UserPromptSubmit", { prompt: "新一轮", event_id: "new-prompt" });
      release();
      await vi.waitFor(() => expect(h.intervals.size).toBe(1));
      expect(h.manager.getSnapshot().turn.status).toBe("running");
      h.append(message(provider, "new-reply", "新回复"));
      await h.tick();
      expect(h.messages().at(-1).text).toBe("新回复");
    } finally { h.service.shutdown(); }
  });
});
