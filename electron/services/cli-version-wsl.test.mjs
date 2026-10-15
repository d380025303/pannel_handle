import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

describe("WSL version command transport", () => {
  it.each([
    ["codebuddy", "codebuddy-acp", "createCodeBuddyVersionService", "CODEBUDDY", "@tencent-ai/codebuddy-code"],
    ["opencode", "opencode-acp", "createOpenCodeVersionService", "OPENCODE", "@opencode/cli"],
    ["codex", "codex-app-server", "createCodexVersionService", "CODEX", "@openai/codex"],
  ])("executes %s probes and updates directly through bash", async (provider, directory, factory, marker, pkg) => {
    let version = "2.55.0";
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => {
        const script = spawnProcess.mock.lastCall[1][5];
        if (script === `npm install -g ${pkg}@latest`) version = "2.56.0";
        else child.stdout.emit("data", [
          `__PANNEL_${marker}_PROBE_BEGIN__`, `__PANNEL_${marker}_VERSION_BEGIN__`,
          provider === "codex" ? `codex-cli ${version}` : version,
          `__PANNEL_${marker}_VERSION_END__`, `commandPath=/usr/local/bin/${provider}`,
          `resolvedPath=/usr/local/lib/node_modules/${pkg}/bin/cli.js`,
          "npmRoot=/usr/local/lib/node_modules", "npmOwned=1",
          ...(provider === "codex" ? ["installDir=/tmp/bin", "codexHome=/tmp/codex", "standaloneOwned=0"] : []),
          `__PANNEL_${marker}_PROBE_END__`,
        ].join("\n"));
        child.emit("close", 0);
      });
      return child;
    });
    const service = require(`./${directory}/version-service.cjs`)[factory]({
      terminalManager: { getSession: () => ({ id: "one", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: provider }) },
      spawnProcess,
      fetchLatest: async () => ({ ok: true, json: async () => ({ version: "2.56.0" }) }),
    });
    expect(await service.check("one")).toMatchObject({ status: "available", currentVersion: "2.55.0", commandPath: `/usr/local/bin/${provider}`, method: "npm" });
    expect(await service.update("one")).toMatchObject({ status: "current", currentVersion: "2.56.0", restartRequired: true });
    expect(spawnProcess).toHaveBeenCalledTimes(4);
    for (const [executable, args] of spawnProcess.mock.calls) {
      expect(executable).toBe("wsl.exe");
      expect(args.slice(0, 5)).toEqual(["-d", "Ubuntu", "--exec", "bash", "-lic"]);
      expect(args).toHaveLength(6);
    }
    const probe = spawnProcess.mock.calls[0][1][5];
    expect(probe).toContain('"$version"');
    expect(probe).toContain(provider === "codex" ? '"$codex_path"' : '"$command_path"');
  });
});
