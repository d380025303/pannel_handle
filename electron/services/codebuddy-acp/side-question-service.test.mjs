import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { createCodeBuddySideQuestionService, sideQuestionContext, sideQuestionInvocation } = require("./side-question-service.cjs");
const services = [];
afterEach(() => { services.splice(0).forEach(({ service, child }) => { service.shutdown(); child.emit("close", 0); }); vi.useRealTimers(); });

function setup(overrides = {}, timeoutMs) {
  const entry = { session: { type: "windows", cwd: "C:\\work", modelSource: "native" }, runtime: {},
    environment: {}, configOptions: [{ id: "model", currentValue: "current-model" }], threadId: "main-thread",
    busy: true, turnId: "main-turn", items: [{ type: "userMessage", text: "完成主任务" }], ...overrides };
  let current = entry;
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  const changed = vi.fn(); const stopChild = vi.fn(); const spawnProcess = vi.fn(() => child);
  const service = createCodeBuddySideQuestionService({ getEntry: () => current, changed, spawnProcess, stopChild, timeoutMs });
  services.push({ service, child });
  return { service, child, entry, changed, stopChild, spawnProcess, replace: value => { current = value; } };
}

describe("CodeBuddy independent side question", () => {
  it("answers concurrently without changing main state, selects the live model and disables tools, MCP, hooks and persistence", () => {
    const fixture = setup();
    const state = fixture.service.ask("run", "目前进展如何？");
    expect(state).toMatchObject({ threadId: "main-thread", status: "running" });
    const [, args, options] = fixture.spawnProcess.mock.calls[0];
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    expect(script).toContain("'--model' 'current-model'");
    for (const flag of ["--tools=", "--strict-mcp-config", "--no-session-persistence"]) expect(script).toContain(flag);
    const settings = script.match(/'--settings' '([^']+)'/)[1];
    expect(JSON.parse(fs.readFileSync(settings, "utf8"))).toEqual({ disableAllHooks: true });
    expect(options.windowsHide).toBe(true);
    const prompt = JSON.parse(fixture.child.stdin.read().toString());
    expect(prompt.context).toContain("完成主任务");
    expect(prompt.question).toBe("目前进展如何？");
    fixture.child.stdout.end(JSON.stringify({ result: "主任务还在运行。", is_error: false }));
    fixture.child.emit("close", 0);
    expect(fixture.service.snapshot("run")).toMatchObject({ status: "completed", answer: "主任务还在运行。" });
    expect(fs.existsSync(settings)).toBe(false);
    expect(fixture.entry).toMatchObject({ busy: true, turnId: "main-turn" });
    expect(fixture.entry.items).toHaveLength(1);
  });

  it("inherits external credentials while dropping the native auth token", () => {
    const fixture = setup({ session: { type: "windows", cwd: "C:\\work", modelSource: "minimax" },
      environment: { CODEBUDDY_AUTH_TOKEN: "native-secret", CODEBUDDY_API_KEY: "external-secret", CODEBUDDY_BASE_URL: "https://example.test" } });
    fixture.service.ask("run", "问题");
    expect(fixture.spawnProcess.mock.calls[0][2].env).toMatchObject({ CODEBUDDY_API_KEY: "external-secret", CODEBUDDY_BASE_URL: "https://example.test" });
    expect(fixture.spawnProcess.mock.calls[0][2].env.CODEBUDDY_AUTH_TOKEN).toBeUndefined();
  });

  it("reads the real CLI JSON message array using only its final result", () => {
    const fixture = setup(); fixture.service.ask("run", "问题");
    fixture.child.stdout.end(JSON.stringify([{ type: "message", role: "assistant", content: [{ text: "intermediate" }] },
      { type: "result", is_error: false, result: "final answer" }]));
    fixture.child.emit("close", 0);
    expect(fixture.service.snapshot("run")).toMatchObject({ status: "completed", answer: "final answer" });
  });

  it("uses recent context, excluding hidden reasoning and non-main events", () => {
    const result = sideQuestionContext([{ type: "reasoning", text: "hidden" }, { type: "turnError", text: "secret error" },
      { type: "userMessage", text: "x".repeat(65000) }, { type: "toolCall", toolName: "Read", output: "recent output" }]);
    expect(result.truncated).toBe(true); expect(result.context).toHaveLength(60000);
    expect(result.context.endsWith("recent output")).toBe(true);
    expect(result.context).not.toContain("hidden");
  });

  it("rejects unsupported environments, missing models and invalid or concurrent requests", () => {
    for (const override of [{ session: { type: "wsl" } }, { runtime: { localBridge: true } }, { threadId: null }]) {
      const fixture = setup(override);
      expect(() => fixture.service.ask("run", "问题")).toThrow("仅已连接");
      expect(fixture.spawnProcess).not.toHaveBeenCalled();
    }
    const fixture = setup();
    expect(() => fixture.service.ask("run", " ")).toThrow("8,000");
    expect(() => fixture.service.ask("run", "x".repeat(8001))).toThrow("8,000");
    expect(() => sideQuestionInvocation({ ...fixture.entry, configOptions: [] }, "settings")).toThrow("模型");
    fixture.service.ask("run", "问题");
    expect(() => fixture.service.ask("run", "第二个问题")).toThrow("正在回答");
  });

  it("cancels only the side process and ignores its late answer", () => {
    const fixture = setup(); const state = fixture.service.ask("run", "问题");
    fixture.service.cancel("run", "wrong-id"); expect(fixture.stopChild).not.toHaveBeenCalled();
    fixture.service.cancel("run", state.requestId);
    fixture.child.stdout.end(JSON.stringify({ result: "late" })); fixture.child.emit("close", 0);
    expect(fixture.service.snapshot("run").status).toBe("cancelled");
    expect(fixture.stopChild).toHaveBeenCalledTimes(1);
    expect(fixture.entry.busy).toBe(true);
  });

  it("does not deliver an old answer after replacing the session", () => {
    const fixture = setup(); fixture.service.ask("run", "问题"); fixture.changed.mockClear();
    fixture.replace({ ...fixture.entry, threadId: "other-thread" });
    fixture.child.stdout.end(JSON.stringify({ result: "old answer" })); fixture.child.emit("close", 0);
    expect(fixture.changed).not.toHaveBeenCalled();
  });

  it("handles timeout and hides credentials in process errors", () => {
    vi.useFakeTimers(); const fixture = setup({}, 10); fixture.service.ask("run", "问题");
    vi.advanceTimersByTime(10);
    expect(fixture.service.snapshot("run")).toMatchObject({ status: "failed", error: "CodeBuddy 旁问超时，请重试。" });
    expect(fixture.stopChild).toHaveBeenCalledTimes(1);
    const failure = setup({ environment: { CODEBUDDY_API_KEY: "sensitive-secret" } });
    failure.service.ask("run", "问题"); failure.child.stderr.write("API key sensitive-secret rejected"); failure.child.emit("close", 1);
    expect(failure.service.snapshot("run").error).not.toContain("sensitive-secret");
  });

  it.each(["not-json", JSON.stringify({ result: "" }), JSON.stringify({ is_error: true, result: "request failed" })])("reports invalid or failed replies: %s", output => {
    const fixture = setup(); fixture.service.ask("run", "问题"); fixture.child.stdout.end(output); fixture.child.emit("close", 0);
    expect(fixture.service.snapshot("run").status).toBe("failed");
  });

  it("bounds output and terminates the worker", () => {
    const fixture = setup(); fixture.service.ask("run", "问题"); fixture.child.stdout.write("x".repeat(8 * 1024 * 1024 + 1));
    expect(fixture.service.snapshot("run")).toMatchObject({ status: "failed", error: "CodeBuddy 旁问输出过大。" });
    expect(fixture.stopChild).toHaveBeenCalledTimes(1);
  });
});
