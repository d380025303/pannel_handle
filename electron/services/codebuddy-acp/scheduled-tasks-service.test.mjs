import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createScheduledTasksService } = require("./scheduled-tasks-service.cjs");
function setup() {
  const request = vi.fn().mockResolvedValue({ data: { tasks: [{ id: "task", prompt: "Check", cron: "* * * * *", recurring: true }] } });
  const assertCurrent = vi.fn();
  const contextFor = vi.fn(() => ({ threadId: "thread", transport: { scheduledTasksRequest: request }, assertCurrent }));
  return { service: createScheduledTasksService(contextFor), request, assertCurrent, contextFor };
}
describe("scheduled tasks", () => {
  it("uses the current thread and only the supported input fields", async () => {
    const { service, request, contextFor } = setup();
    expect(await service.list("run", "thread")).toEqual([{ id: "task", prompt: "Check", cron: "* * * * *", recurring: true, durable: false, enabled: true }]);
    await service.create("run", "thread", { prompt: " New ", cron: "*/5 * * * *", recurring: false, durable: true, sessionId: "foreign" });
    expect(contextFor).toHaveBeenCalledWith("run", "thread");
    expect(request).toHaveBeenLastCalledWith("POST", "thread", null, { prompt: "New", cron: "*/5 * * * *", recurring: false, durable: true });
    await service.delete("run", "thread", "task");
    expect(request).toHaveBeenLastCalledWith("DELETE", "thread", "task", undefined);
  });
  it("rejects invalid input, malformed responses and foreign tasks", async () => {
    const { service, request } = setup();
    await expect(service.create("run", "thread", { prompt: "", cron: "* * * * *" })).rejects.toThrow("任务内容");
    await expect(service.create("run", "thread", { prompt: "x", cron: "bad" })).rejects.toThrow("五段");
    await expect(service.create("run", "thread", { prompt: "x", cron: "* * * * *", recurring: "true", durable: false })).rejects.toThrow("选项");
    await expect(service.delete("run", "thread", "foreign")).rejects.toThrow("不属于");
    expect(request).not.toHaveBeenCalledWith("DELETE", expect.anything(), expect.anything(), expect.anything());
    request.mockResolvedValue({ data: {} });
    await expect(service.list("run", "thread")).rejects.toThrow("格式");
    request.mockRejectedValue(new Error("cron disabled"));
    await expect(service.list("run", "thread")).rejects.toThrow("cron disabled");
  });
  it("stops deletion if the conversation changes while listing", async () => {
    const { service, assertCurrent, request } = setup();
    assertCurrent.mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error("对话已切换"); });
    await expect(service.delete("run", "thread", "task")).rejects.toThrow("切换");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

it("restricts session service operations to Windows and rejects stale thread IDs", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { createCodeBuddyAcpSessionService } = require("./session-service.cjs");
  const events = new EventEmitter();
  const request = vi.fn().mockResolvedValue({ data: { tasks: [] } });
  const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
    terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(),
    spawnProcess: () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() }),
    resolveHttpEndpoint: async () => ({ endpoint: new URL("http://127.0.0.1:12345"), password: "test" }),
    httpTransportFactory: () => ({ on: (name, listener) => events.on(name, listener), connect: async () => {}, close: () => {}, scheduledTasksRequest: request,
      send: async m => { if (m.id != null) events.emit("message", { id: m.id, result: m.method === "session/new" ? { sessionId: "thread" } : { agentCapabilities: {} } }); } }) });
  await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
  await expect(service.listScheduledTasks("one", "thread")).resolves.toEqual([]);
  expect(() => service.listScheduledTasks("one", "stale")).toThrow("切换");
  await service.close("one");
  expect(() => service.listScheduledTasks("one", "thread")).toThrow();
  await service.shutdown();
});
