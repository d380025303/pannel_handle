import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createReviewerAgentRunner, DISABLED_FEATURES } = require("./reviewer-agent-runner.cjs");
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
it("settles cancellation when a descendant keeps the parent's stdout pipe open", async () => {
  const f = fixture([]);
  f.child.stdin.removeAllListeners("finish");
  f.child.kill.mockImplementation(() => { queueMicrotask(() => f.child.emit("exit", -1)); });
  const controller = new AbortController();
  const operation = f.review({ signal: controller.signal });
  await vi.waitFor(() => expect(f.getInvocation()).toBeDefined());
  controller.abort(new Error("cancelled by user"));
  await expect(operation).rejects.toThrow("cancelled by user");
  expect(f.child.stdout.destroyed).toBe(true);
  expect(fs.existsSync(f.getInvocation().options.cwd)).toBe(false);
});
it("rejects inadequate budgets before invoking the CLI", async () => {
  const f = fixture([]);
  await expect(f.review({ maxTokens: 10000 })).rejects.toThrow("系统上下文");
  expect(f.executeProbe).not.toHaveBeenCalled();
});
it("handles a disabled Code Mode notice while preserving genuine model errors", async () => {
  const notice = fixture([{ type: "item.completed", item: { type: "error", message: "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed." } }, { type: "item.completed", item: { type: "agent_message", text: '{"findings":[]}' } }]);
  expect(await notice.review()).toMatchObject({ findings: [] });
  const failure = fixture([{ type: "item.completed", item: { type: "error", message: "Model authentication failed" } }]);
  await expect(failure.review()).rejects.toThrow("authentication failed");
}); });
function fixture(events, code = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inspector-runner-")); roots.push(root);
  let input = ""; let invocation;
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  let closed = false;
  child.kill = vi.fn(() => { if (!closed) { closed = true; queueMicrotask(() => child.emit("close", -1)); } });
  child.stdin.on("data", chunk => { input += chunk.toString(); });
  child.stdin.on("finish", () => queueMicrotask(() => {
    for (const event of events) child.stdout.write(JSON.stringify(event) + "\n");
    if (!closed) { closed = true; child.emit("close", code); }
  }));
  const executeProbe = vi.fn(async (_exe, args) => ({ stdout: args[0] === "exec" ? "--ignore-user-config --ignore-rules --ephemeral --output-schema" : [...DISABLED_FEATURES, "skip_host_skill_discovery"].map(name => `${name} stable true`).join("\n") }));
  const runner = createReviewerAgentRunner({ userData: root, resolveExecutable: async () => "codex.exe", executeProbe,
    spawnProcess: (_exe, args, options) => { invocation = { args, options }; return child; } });
  const review = (options = {}) => runner.review({ role: { name: "test", focus: ["errors"] }, run: { headCommit: "abc" }, sources: new Map([["src/a.js", "const api_key='abcdefghijk';"]]), maxTokens: 20000, signal: new AbortController().signal, model: "", ...options });
  return { root, child, review, executeProbe, getInvocation: () => invocation, getInput: () => input };
}
it("sends redacted scoped sources through stdin with independent read-only and tool controls", async () => {
  const f = fixture([{ type: "item.completed", item: { type: "agent_message", text: '{"findings":[]}' } }, { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10 } }]);
  expect(await f.review()).toMatchObject({ findings: [], usage: { input_tokens: 100 } });
  const { args, options } = f.getInvocation();
  expect(args).toContain("--ignore-user-config"); expect(args).toContain("read-only");
  expect(args).toContain("mcp_servers={}"); expect(args).toContain("hooks");
  expect(args).not.toContain("abcdefghijk"); expect(f.getInput()).not.toContain("abcdefghijk");
  expect(f.getInput()).toContain("[REDACTED]"); expect(options.cwd).not.toBe("src");
  expect(fs.existsSync(options.cwd)).toBe(false);
});
it("terminates an unauthorized tool event and never accepts its findings", async () => {
  const f = fixture([{ type: "item.started", item: { type: "command_execution", command: "write" } }, { type: "item.completed", item: { type: "agent_message", text: '{"findings":[]}' } }]);
  await expect(f.review()).rejects.toThrow("未授权工具"); expect(f.child.kill).toHaveBeenCalled();
});
it("rejects a CLI lacking required isolation capabilities before spawning", async () => {
  const f = fixture([]); f.executeProbe.mockResolvedValue({ stdout: "old CLI" });
  await expect(f.review()).rejects.toThrow("隔离选项"); expect(f.getInvocation()).toBeUndefined();
});
it("rejects invalid structured output and over-budget usage", async () => {
  const invalid = fixture([{ type: "item.completed", item: { type: "agent_message", text: "not-json" } }]);
  await expect(invalid.review()).rejects.toThrow("结构化巡检结果");
  const costly = fixture([{ type: "turn.completed", usage: { input_tokens: 19000, output_tokens: 2000 } }]);
  await expect(costly.review()).rejects.toThrow("超过预算");
});

it("uses the selected template environment for isolation probes and the agent process", async () => {
  const f = fixture([{ type: "item.completed", item: { type: "agent_message", text: '{"findings":[]}' } }]);
  await f.review({ project: { templateSnapshot: { type: "windows", agentProvider: "codex", environmentOverrides: [{ name: "INSPECTOR_TEST_ENV", value: "selected" }] } }, model: "template-model" });
  expect(f.executeProbe.mock.calls[0][2].env.INSPECTOR_TEST_ENV).toBe("selected");
  expect(f.getInvocation().options.env.INSPECTOR_TEST_ENV).toBe("selected");
  expect(f.getInvocation().args).toContain("template-model");
  expect(process.env.INSPECTOR_TEST_ENV).toBeUndefined();
});
