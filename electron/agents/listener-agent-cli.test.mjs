import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildInvocation, createListenerAgentCli } = require("./listener-agent-cli.cjs");

describe("listener Agent CLI adapters", () => {
  it("uses non-interactive read-only modes without dangerous bypass flags", () => {
    const session = { type: "windows", cwd: "C:\\work" };
    for (const provider of ["claude", "codex", "opencode", "qoder"]) {
      const invocation = buildInvocation(provider, "read-only", "review", session);
      expect([invocation.command, ...invocation.args].join(" ")).not.toMatch(/dangerously|bypass_permissions/);
    }
    expect(buildInvocation("codex", "read-only", "review", session).args).toContain("read-only");
    expect(buildInvocation("qoder", "read-only", "review", session).args).toContain("--print");
  });

  it("maps write mode to bounded workspace editing modes", () => {
    expect(buildInvocation("codex", "write", "fix", {}).args).toContain("workspace-write");
    expect(buildInvocation("qoder", "write", "fix", {}).args).toContain("accept_edits");
    expect(buildInvocation("opencode", "write", "fix", {}).args).toContain("build");
  });

  it("uses an encoded PowerShell bridge for Windows cmd wrappers without interpolating prompts", async () => {
    let spawned;
    const spawn = vi.fn((command, args, options) => {
      spawned = { command, args, options };
      const child = new EventEmitter();
      child.pid = 123;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: vi.fn() };
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });
    const cli = createListenerAgentCli({ spawn, spawnSync: vi.fn(() => ({ status: 0 })) });
    const prompt = "review & Remove-Item C:\\important";
    const handle = await cli.run({ type: "windows", cwd: "C:\\work" }, { provider: "opencode", permission: "read-only", name: "Review" }, prompt);
    await handle.promise;

    expect(spawned.command).toBe("powershell.exe");
    expect(spawned.args.join(" ")).not.toContain(prompt);
    expect(spawned.options.env.PANNEL_LISTENER_PROMPT).toBe(prompt);
    expect(spawned.options.env.PANNEL_LISTENER_COMMAND).toBe("opencode");
  });
});
