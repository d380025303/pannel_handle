import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const providers = [
  ["opencode", "opencode-acp", "createOpenCodeVersionService", "@opencode/cli"],
  ["codebuddy", "codebuddy-acp", "createCodeBuddyVersionService", "@tencent-ai/codebuddy-code"],
  ["codex", "codex-app-server", "createCodexVersionService", "@openai/codex"],
];

describe.each(providers)("%s installation identity", (provider, directory, factory, pkg) => {
  function harness(change = "none") {
    let probes = 0;
    let version = "2.0.0";
    const install = vi.fn(() => { version = "2.1.0"; });
    const executeCommand = async (_target, script) => {
      if (script === `npm install -g ${pkg}@latest`) return install();
      probes += 1;
      const changed = change === "before" ? probes >= 2 : change === "after" && probes >= 3;
      const root = changed ? "/opt/node/other/lib/node_modules" : "/opt/node/lib/node_modules";
      const marker = provider.toUpperCase();
      return [
        `__PANNEL_${marker}_PROBE_BEGIN__`, `__PANNEL_${marker}_VERSION_BEGIN__`,
        provider === "codex" ? `codex-cli ${version}` : version,
        `__PANNEL_${marker}_VERSION_END__`,
        `commandPath=/run/user/0/fnm_multishells/${probes}/bin/${provider}`,
        `resolvedPath=${root}/${pkg}/bin/cli.js`, `npmRoot=${root}`, "npmOwned=1",
        ...(provider === "codex" ? ["installDir=/tmp/bin", "codexHome=/tmp/codex", "standaloneOwned=0"] : []),
        `__PANNEL_${marker}_PROBE_END__`,
      ].join("\n");
    };
    const service = require(`./${directory}/version-service.cjs`)[factory]({
      terminalManager: { getSession: () => ({ id: "one", type: "ssh", agentLocation: "remote", runtimeMode: "app-server", agentProvider: provider }) },
      executeCommand,
      fetchLatest: async () => ({ ok: true, json: async () => ({ version: "2.1.0" }) }),
    });
    return { service, install };
  }

  it("updates when each login shell changes only the fnm command path", async () => {
    const { service, install } = harness();
    expect(await service.check("one")).toMatchObject({ status: "available", resolvedPath: `/opt/node/lib/node_modules/${pkg}/bin/cli.js` });
    expect(await service.update("one")).toMatchObject({ status: "current", currentVersion: "2.1.0", restartRequired: true });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("does not install when the resolved installation changes before updating", async () => {
    const { service, install } = harness("before");
    await service.check("one");
    if (provider === "codex") expect(await service.update("one")).toMatchObject({ status: "available" });
    else await expect(service.update("one")).rejects.toThrow("安装已变化");
    expect(install).not.toHaveBeenCalled();
  });

  it("rejects verification when the resolved installation changes after updating", async () => {
    const { service, install } = harness("after");
    await service.check("one");
    await expect(service.update("one")).rejects.toThrow("未切换到新版本");
    expect(install).toHaveBeenCalledTimes(1);
  });
});

describe("shared installation comparison", () => {
  const { sameInstallation } = require("./cli-version-installation.cjs");
  const before = { commandPath: "/bin/cli", resolvedPath: "/real/cli", method: "npm" };

  it("retains command path comparison outside Linux npm installs", () => {
    expect(sameInstallation(before, { ...before, commandPath: "/other/cli" }, "windows")).toBe(false);
    const standalone = { ...before, method: "standalone" };
    expect(sameInstallation(standalone, { ...standalone, commandPath: "/other/cli" }, "linux")).toBe(false);
  });

  it("rejects an installation method change even with matching paths", () => {
    expect(sameInstallation(before, { ...before, method: "unknown" }, "linux")).toBe(false);
  });
});
