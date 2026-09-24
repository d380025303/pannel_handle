import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createProjectAssistantService } = require("./project-assistant-service.cjs");

function fixture({ failNewThread = false } = {}) {
  let stored = JSON.stringify({ threadId: "old-thread", messages: [{ role: "assistant", text: "旧消息", at: 1 }] });
  let threadStarts = 0;
  let holdTurn = false;
  const requests = [];
  const processHandle = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn()
  });
  let input = "";
  processHandle.stdin.on("data", chunk => {
    input += chunk.toString();
    let newline;
    while ((newline = input.indexOf("\n")) >= 0) {
      const message = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      if (message.id == null) continue;
      requests.push(message);
      let result = {};
      let error;
      if (message.method === "account/read") result = { requiresOpenaiAuth: false };
      if (message.method === "thread/start") {
        threadStarts++;
        if (failNewThread && threadStarts === 1) error = { message: "Could not create thread" };
        else result = { thread: { id: `new-thread-${threadStarts}` } };
      }
      if (message.method === "turn/start") {
        result = { turn: { id: "turn-1" } };
        if (holdTurn) continue;
      }
      queueMicrotask(() => processHandle.stdout.write(`${JSON.stringify({ id: message.id, ...(error ? { error } : { result }) })}\n`));
    }
  });
  const fsApi = {
    readFileSync: vi.fn(() => stored), mkdirSync: vi.fn(), writeFileSync: vi.fn((_file, value) => { stored = value; }), renameSync: vi.fn()
  };
  const service = createProjectAssistantService({
    userData: "C:\\test-user-data", broadcast: vi.fn(), fsApi, spawnProcess: () => processHandle,
    dependencies: {
      terminalManager: { listSessions: () => [] }, sessionStore: { getLibrary: () => [] },
      launchTemplateStore: { getAll: () => [] }, tokenUsageModule: { getDashboard: () => ({ range: "30d", summary: {}, providerBreakdown: [] }) },
      codexSessionControl: { listSessions: () => [], getContext: async () => null }
    }
  });
  return { service, fsApi, requests, getStored: () => JSON.parse(stored), holdTurn: () => { holdTurn = true; } };
}

describe("project assistant new conversation", () => {
  it("creates and persists an empty thread, leaving the old thread available", async () => {
    const { service, requests, getStored } = fixture();
    await service.start();
    const next = await service.newConversation();
    expect(next).toMatchObject({ threadId: "new-thread-1", messages: [], pendingAction: null, error: null });
    expect(getStored()).toEqual({ threadId: "new-thread-1", messages: [] });
    expect(requests.filter(item => item.method === "thread/start")).toHaveLength(1);
    expect(requests.some(item => item.method === "thread/resume" && item.params.threadId === "old-thread")).toBe(true);
    service.shutdown();
  });

  it("keeps the old conversation when thread creation fails", async () => {
    const { service, getStored } = fixture({ failNewThread: true });
    await service.start();
    await expect(service.newConversation()).rejects.toThrow("Could not create thread");
    expect(service.snapshot()).toMatchObject({ threadId: "old-thread", messages: [{ text: "旧消息" }] });
    expect(getStored().threadId).toBe("old-thread");
    service.shutdown();
  });

  it("rejects a new conversation while a reply is running", async () => {
    const { service, holdTurn } = fixture();
    await service.start();
    holdTurn();
    const pending = service.sendMessage("你好").catch(() => undefined);
    await vi.waitFor(() => expect(service.snapshot().busy).toBe(true));
    await expect(service.newConversation()).rejects.toThrow("busy");
    expect(service.snapshot().threadId).toBe("old-thread");
    service.shutdown();
    await pending;
  });
});
