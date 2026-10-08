import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const require = createRequire(import.meta.url);
const { createOpenCodeAcpSessionService } = require("./session-service.cjs");
const services = [];
afterEach(() => { for (const service of services.splice(0)) service.shutdown(); });

async function fixture() {
  const messages = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn();
  const emit = value => child.stdout.write(`${JSON.stringify(value)}\n`);
  child.stdin.on("data", chunk => {
    const message = JSON.parse(String(chunk)); messages.push(message);
    if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: { sessionCapabilities: { close: {} } } } });
    if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "thread" } });
    if (message.method === "session/close") emit({ id: message.id, result: {} });
  });
  const spawnProcess = vi.fn(() => child);
  const status = vi.fn();
  const service = createOpenCodeAcpSessionService({ environmentService: { resolve: () => ({}) },
    terminalManager: { broadcastAgentStatus: status }, broadcast: vi.fn(), spawnProcess });
  services.push(service);
  await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
  const ask = (schema, extra = {}, id = "question") => emit({ id, method: "elicitation/create", params: {
    mode: "form", sessionId: "thread", toolCallId: "tool", message: "选择方案", requestedSchema: schema, ...extra } });
  return { service, messages, child, emit, ask, status, spawnProcess,
    response: (id = "question") => messages.find(message => message.id === id && message.result)?.result };
}

const choices = [{ const: "safe", title: "稳妥" }, { const: "fast", title: "快速" }];
function schema(multiple = false, custom = false) {
  return { type: "object", required: ["strategy"], properties: {
    strategy: { title: "方案", description: "采用哪种方案？", ...(multiple
      ? { type: "array", items: { type: "string", oneOf: choices } } : { type: "string", oneOf: choices }) },
    ...(custom ? { strategy_custom: { type: "string", title: "其他" } } : {}) } };
}

it("advertises native forms without injecting a question MCP or disabling the built-in tool", async () => {
  const f = await fixture();
  expect(f.messages[0].params.clientCapabilities).toEqual({ auth: { terminal: true }, elicitation: { form: {} }, session: { compaction: {} } });
  expect(f.messages.find(message => message.method === "session/new").params.mcpServers).toEqual([]);
  expect(f.spawnProcess.mock.calls[0][2].env.OPENCODE_ENABLE_QUESTION_TOOL).toBeUndefined();
  expect(f.spawnProcess.mock.calls[0][2].env.PANNEL_HANDLE_OPENCODE_QUESTION_URL).toBeUndefined();
});

it.each([
  [false, false, { answers: ["快速"] }, { strategy: "fast" }],
  [true, false, { answers: ["稳妥", "快速"] }, { strategy: ["safe", "fast"] }],
  [false, true, { answers: ["自行设计"], customAnswer: "自行设计" }, { strategy: "safe", strategy_custom: "自行设计" }],
  [true, true, { answers: ["快速", "自行设计"], customAnswer: "自行设计" }, { strategy: ["fast"], strategy_custom: "自行设计" }],
  [true, true, { answers: ["自行设计"], customAnswer: "自行设计" }, { strategy: [], strategy_custom: "自行设计" }],
  [true, true, { answers: ["快速", "快速"], customAnswer: "快速" }, { strategy: ["fast"], strategy_custom: "快速" }]
])("returns native choice/custom content (multiple=%s custom=%s)", async (multiple, custom, answer, content) => {
  const f = await fixture(); f.ask(schema(multiple, custom));
  const question = f.service.snapshot("one").questions[0];
  expect(question.params.itemId).toBe("tool");
  expect(question.params.questions).toHaveLength(1);
  expect(question.params.questions[0]).toMatchObject({ id: "strategy", multiSelect: multiple, isOther: custom });
  expect(f.status).toHaveBeenLastCalledWith(expect.objectContaining({ status: "e_prompt", eventName: "AcpQuestion" }));
  await f.service.answerQuestion("one", "question", { strategy: answer });
  expect(f.response()).toEqual({ action: "accept", content });
  expect(f.service.snapshot("one").questions).toHaveLength(0);
  expect(f.service.snapshot("one").items.at(-1)).toMatchObject({ type: "questionAnswer", questions: [{ answers: answer.answers }] });
});

it("handles several questions, free text and omitted optional answers", async () => {
  const f = await fixture();
  f.ask({ type: "object", required: ["name", "strategy"], properties: {
    name: { type: "string", title: "项目名称" }, strategy: schema().properties.strategy,
    note: { type: "string", title: "备注" } } });
  await expect(f.service.answerQuestion("one", "question", { strategy: { answers: ["稳妥"] } })).rejects.toThrow("必填");
  expect(f.service.snapshot("one").questions[0].submitting).toBe(false);
  await f.service.answerQuestion("one", "question", { name: { answers: ["工具"] }, strategy: { answers: ["稳妥"] }, note: { answers: [] } });
  expect(f.response()).toEqual({ action: "accept", content: { name: "工具", strategy: "safe" } });
});

it.each([
  { answers: ["不存在"] }, { answers: ["稳妥", "快速"] }, { answers: [" "] },
  { answers: ["自行设计"], customAnswer: "自行设计" }
])("rejects invalid answers and lets the user retry", async answer => {
  const f = await fixture(); f.ask(schema());
  await expect(f.service.answerQuestion("one", "question", { strategy: answer })).rejects.toThrow();
  expect(f.response()).toBeUndefined();
  expect(f.service.snapshot("one").questions[0].submitting).toBe(false);
});

it.each([
  [{ type: "object", properties: {} }, {}],
  [{ type: "object", properties: { nested: { type: "object" } } }, {}],
  [schema(), { sessionId: "old-thread" }], [schema(), { mode: "url" }],
  [{ type: "object", properties: { q: { type: "string", oneOf: [{ const: "a", title: "相同" }, { const: "b", title: "相同" }] } } }, {}]
])("cancels forms that cannot be shown", async (value, extra) => {
  const f = await fixture(); f.ask(value, extra);
  expect(f.response()).toEqual({ action: "cancel" });
  expect(f.service.snapshot("one").questions).toHaveLength(0);
});

it.each(["cancel", "interrupt", "close", "disconnect", "agent-cancel"])("clears native questions on %s and rejects stale answers", async action => {
  const f = await fixture(); f.ask(schema());
  if (action === "cancel") await f.service.cancelQuestion("one", "question");
  if (action === "interrupt") f.service.interrupt("one");
  if (action === "close") await f.service.close("one");
  if (action === "disconnect") f.child.emit("exit", 1);
  if (action === "agent-cancel") f.emit({ method: "$/cancel_request", params: { requestId: "question" } });
  if (action !== "close") expect(f.service.snapshot("one").questions).toHaveLength(0);
  if (action !== "disconnect") expect(f.response()).toEqual({ action: "cancel" });
  await expect(f.service.answerQuestion("one", "question", { strategy: { answers: ["稳妥"] } })).rejects.toThrow();
});
