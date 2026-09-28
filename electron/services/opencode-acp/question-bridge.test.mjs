import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOpenCodeQuestionBridge } = require("./question-bridge.cjs");
let bridge;
afterEach(() => { bridge?.close(); bridge = null; });

async function rpc(method, params, id = 1, token = bridge.token) {
  const response = await fetch(bridge.url, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  return { status: response.status, body: await response.json() };
}

describe("OpenCode question MCP bridge", () => {
  it("advertises a question tool, shows its request, and returns the user's answers", async () => {
    const onQuestion = vi.fn();
    bridge = await createOpenCodeQuestionBridge({ session: { id: "one", type: "windows" }, onQuestion });
    expect((await rpc("initialize", { protocolVersion: "2025-06-18" })).body.result.capabilities.tools).toEqual({ listChanged: false });
    const tools = (await rpc("tools/list")).body.result.tools;
    expect(tools[0].name).toBe("ask_user_question");
    const pending = rpc("tools/call", { name: tools[0].name, arguments: { questions: [{
      question: "选择方案？", options: [{ label: "甲", description: "推荐" }, { label: "乙" }]
    }] } }, 5);
    await vi.waitFor(() => expect(onQuestion).toHaveBeenCalledOnce());
    const { requestId, questions } = onQuestion.mock.calls[0][0];
    expect(questions).toMatchObject([{ id: "q_0", question: "选择方案？", isOther: true }]);
    bridge.answer(requestId, { q_0: ["甲"] });
    expect((await pending).body).toMatchObject({ id: 5, result: { content: [{ text: '{"answers":{"q_0":["甲"]}}' }] } });
    expect((await rpc("tools/list", undefined, 7, "wrong")).status).toBe(401);
  });

  it("unblocks the tool when the user cancels or the bridge closes", async () => {
    const onQuestion = vi.fn();
    bridge = await createOpenCodeQuestionBridge({ session: { id: "one", type: "windows" }, onQuestion });
    const ask = () => rpc("tools/call", { name: "ask_user_question", arguments: { questions: [{ question: "继续？" }] } });
    const first = ask();
    await vi.waitFor(() => expect(onQuestion).toHaveBeenCalledTimes(1));
    bridge.cancel(onQuestion.mock.calls[0][0].requestId);
    expect((await first).body.result.isError).toBe(true);
    const second = ask();
    await vi.waitFor(() => expect(onQuestion).toHaveBeenCalledTimes(2));
    bridge.cancelAll();
    expect((await second).body.result.isError).toBe(true);
  });

  it("uses an SSH reverse forwarder for an agent running remotely", async () => {
    const forwarder = { url: "http://127.0.0.1:54123", close: vi.fn() };
    const createReverseHttpForwarder = vi.fn(async () => forwarder);
    bridge = await createOpenCodeQuestionBridge({ session: { id: "one", type: "ssh", agentLocation: "remote" },
      sshAgentTransport: { createReverseHttpForwarder }, onQuestion: vi.fn() });
    expect(bridge.url).toBe("http://127.0.0.1:54123/mcp");
    expect(createReverseHttpForwarder).toHaveBeenCalledWith("one", expect.any(Number));
    bridge.close();
    expect(forwarder.close).toHaveBeenCalledOnce();
  });

  it("checks WSL access to the local question endpoint", async () => {
    const runCommand = vi.fn(() => ({ status: 0 }));
    bridge = await createOpenCodeQuestionBridge({ session: { id: "one", type: "wsl", wslDistro: "Ubuntu" },
      onQuestion: vi.fn(), runCommand });
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(runCommand.mock.calls[0][1]).toEqual(expect.arrayContaining(["-d", "Ubuntu"]));
    expect((await rpc("tools/list")).body.result.tools[0].name).toBe("ask_user_question");
  });

  it("uses the WSL gateway address when localhost forwarding is unavailable", async () => {
    const runCommand = vi.fn().mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0, stdout: "127.0.0.1\n" });
    bridge = await createOpenCodeQuestionBridge({ session: { id: "one", type: "wsl", wslDistro: "Ubuntu" },
      onQuestion: vi.fn(), runCommand });
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect((await rpc("tools/list")).status).toBe(200);
  });
});
