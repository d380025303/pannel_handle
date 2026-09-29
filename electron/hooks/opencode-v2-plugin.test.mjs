import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOpenCodeQuestionBridge } = require("../services/opencode-acp/question-bridge.cjs");

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PANNEL_HANDLE_HOOK_URL;
  delete process.env.PANNEL_HANDLE_SESSION_ID;
  delete process.env.PANNEL_HANDLE_OPENCODE_QUESTION_URL;
  delete process.env.PANNEL_HANDLE_OPENCODE_QUESTION_TOKEN;
});

it("routes the built-in question tool through the graphical answer card", async () => {
  const source = fs.readFileSync(new URL("./hook-assets/pannel-handle-opencode-question.js", import.meta.url), "utf8");
  const { default: plugin } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const onQuestion = vi.fn();
  const bridge = await createOpenCodeQuestionBridge({ session: { id: "one", type: "windows" }, onQuestion });
  process.env.PANNEL_HANDLE_OPENCODE_QUESTION_URL = bridge.url;
  process.env.PANNEL_HANDLE_OPENCODE_QUESTION_TOKEN = bridge.token;
  let questionTool;
  await plugin.setup({ tool: { transform: async callback => callback({ add: definition => { questionTool = definition; } }) } });
  try {
    expect(questionTool.name).toBe("question");
    const input = { questions: [
      { header: "方向", question: "优先做什么？", options: [{ label: "甲" }, { label: "乙" }], multiple: false },
      { header: "补充", question: "还有什么要求？", options: [], custom: true }
    ] };
    const pending = questionTool.execute(input);
    await vi.waitFor(() => expect(onQuestion).toHaveBeenCalledOnce());
    const request = onQuestion.mock.calls[0][0];
    expect(request.questions).toMatchObject([
      { id: "q_0", question: "优先做什么？", multiSelect: false },
      { id: "q_1", question: "还有什么要求？", isOther: true }
    ]);
    bridge.answer(request.requestId, { q_0: ["甲"], q_1: ["保持简单"] });
    expect(await pending).toMatchObject({ metadata: { answers: [["甲"], ["保持简单"]] } });

    const cancelled = questionTool.execute({ questions: [input.questions[0]] });
    await vi.waitFor(() => expect(onQuestion).toHaveBeenCalledTimes(2));
    bridge.cancel(onQuestion.mock.calls[1][0].requestId);
    await expect(cancelled).rejects.toThrow("用户取消了提问");
  } finally { bridge.close(); }
});

it("leaves the built-in question tool alone outside graphical sessions", async () => {
  const source = fs.readFileSync(new URL("./hook-assets/pannel-handle-opencode-question.js", import.meta.url), "utf8");
  const { default: plugin } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const transform = vi.fn();
  await plugin.setup({ tool: { transform } });
  expect(transform).not.toHaveBeenCalled();
});

it("reports V2 execution, tool, text, and token events through the existing Hook endpoint", async () => {
  const source = fs.readFileSync(new URL("./hook-assets/pannel-handle-opencode-plugin.js", import.meta.url), "utf8");
  const { default: plugin } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const sent = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true };
  }));
  process.env.PANNEL_HANDLE_HOOK_URL = "http://127.0.0.1:9000/claude-hook";
  process.env.PANNEL_HANDLE_SESSION_ID = "panel-1";
  const hooks = new Map();
  const events = [
    { type: "session.execution.started", data: { sessionID: "ses-1" } },
    { type: "session.step.started", data: { sessionID: "ses-1", assistantMessageID: "msg-1", model: { id: "model-1" } } },
    { type: "session.text.ended", data: { sessionID: "ses-1", assistantMessageID: "msg-1", text: "Done" } },
    { type: "session.step.ended", created: 100, data: { sessionID: "ses-1", assistantMessageID: "msg-1", finish: "stop",
      tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } },
    { type: "session.execution.succeeded", data: { sessionID: "ses-1" } }
  ];
  const stop = await plugin.setup({
    location: { directory: "C:\\work" },
    tool: { hook: async (name, callback) => { hooks.set(name, callback); } },
    event: { subscribe: async function* () { yield* events; } }
  });
  hooks.get("execute.after")({ sessionID: "ses-1", tool: "pannel_handle_remote_read", status: "completed", result: { content: "ok" } });
  await vi.waitFor(() => expect(sent).toHaveLength(5));
  expect(sent.map(item => item.event_name)).toEqual(expect.arrayContaining([
    "session.status", "message.part.updated", "message.updated", "session.idle", "tool.execute.after"
  ]));
  expect(sent.find(item => item.event_name === "message.updated").info).toMatchObject({
    modelID: "model-1", tokens: { input: 3, output: 2 }
  });
  expect(sent.every(item => item.pannel_handle_session_id === "panel-1")).toBe(true);
  stop();
});
