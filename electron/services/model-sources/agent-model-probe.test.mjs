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
});
