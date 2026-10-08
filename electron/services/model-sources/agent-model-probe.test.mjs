import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { runAgentModelProbe } = require("./agent-model-probe.cjs");

function processMock(code, output) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => { child.stdout.emit("data", output); child.emit("exit", code); });
  return child;
}

describe("Agent model probe", () => {
  const config = { agent: "codebuddy", providerId: "openrouter", modelId: "vendor/coder", baseUrl: "https://openrouter.ai/api/v1", apiKey: "private-key", apiKeyEnv: "OPENROUTER_API_KEY" };
  it("passes the key only through the child environment", async () => {
    const spawnProcess = vi.fn((_command, _args, options) => {
      expect(readFileSync(path.join(options.cwd, "proof.txt"), "utf8")).toBe("probe-success");
      return processMock(0, "probe-success");
    });
    expect(await runAgentModelProbe(config, { spawnProcess, probeToken: "probe-success" })).toMatchObject({ status: "passed" });
    const [command, args, options] = spawnProcess.mock.calls[0];
    expect(`${command} ${args.join(" ")}`).not.toContain("private-key");
    expect(`${command} ${args.join(" ")}`).not.toContain("probe-success");
    expect(options.env.CODEBUDDY_API_KEY).toBe("private-key");
    expect(options.env.CODEBUDDY_AUTH_TOKEN).toBeUndefined();
    expect(existsSync(options.cwd)).toBe(false);
  });
  it("redacts the key from CLI errors", async () => {
    const result = await runAgentModelProbe(config, { spawnProcess: () => processMock(1, "Rejected private-key"), probeToken: "probe-success" });
    expect(result).toMatchObject({ status: "failed", error: "Rejected [redacted]" });
  });
  it("injects the exact MiniMax model registration into the real CLI probe", async () => {
    const spawnProcess = vi.fn(() => processMock(0, "probe-success"));
    await runAgentModelProbe({ ...config, providerId: "minimax", modelId: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1" },
      { spawnProcess, probeToken: "probe-success" });
    const [command, args, options] = spawnProcess.mock.calls[0];
    expect(`${command} ${args.join(" ")}`).toContain("--model MiniMax-M3");
    expect(JSON.parse(options.env.ACC_PRODUCT_CONFIG_V3).models).toContainEqual({
      id: "MiniMax-M3", name: "MiniMax-M3", url: "https://api.minimaxi.com/v1", tags: ["custom"]
    });
    expect(options.env.ACC_PRODUCT_CONFIG_V3).not.toContain("private-key");
  });
  it("runs OpenCode with a private server that receives the injected model configuration", async () => {
    const spawnProcess = vi.fn(() => processMock(1, "Model unavailable"));
    await runAgentModelProbe({ ...config, agent: "opencode", providerId: "minimax", modelId: "MiniMax-M2.7-highspeed", apiKeyEnv: "MINIMAX_API_KEY" }, { spawnProcess });
    const [command, args, options] = spawnProcess.mock.calls[0];
    expect(`${command} ${args.join(" ")}`).toContain("run --standalone --model minimax/MiniMax-M2.7-highspeed");
    expect(JSON.parse(options.env.OPENCODE_CONFIG_CONTENT).providers.minimax.models).toHaveProperty("MiniMax-M2.7-highspeed");
  });
});
