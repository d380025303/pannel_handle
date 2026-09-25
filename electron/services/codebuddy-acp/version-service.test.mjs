import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCodeBuddyVersionService, installation } = require("./version-service.cjs");

const windowsProbe = version => [
  `codebuddy ${version}`, "C:\\node\\codebuddy.ps1", "C:\\node\\codebuddy.ps1",
  "C:\\node\\node_modules", "1"
].join("\n");
const linuxProbe = (version, owned = true) => [
  `codebuddy ${version}`, "/usr/local/bin/codebuddy",
  owned ? "/usr/local/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy.js" : "/opt/codebuddy/bin/codebuddy",
  "/usr/local/lib/node_modules", owned ? "1" : "0"
].join("\n");

function harness(session, output) {
  const executeCommand = vi.fn(async () => output());
  const fetchLatest = vi.fn(async () => ({ ok: true, json: async () => ({ version: "2.56.0" }) }));
  const service = createCodeBuddyVersionService({ terminalManager: { getSession: () => session }, executeCommand, fetchLatest });
  return { service, executeCommand, fetchLatest };
}

describe("CodeBuddy version updates", () => {
  it("recognizes only the active npm installation", () => {
    expect(installation(windowsProbe("2.55.0").split("\n"), "windows")).toBe("npm");
    expect(installation(linuxProbe("2.55.0").split("\n"), "linux")).toBe("npm");
    expect(installation(linuxProbe("2.55.0", false).split("\n"), "linux")).toBe("unknown");
    expect(installation(windowsProbe("2.55.0").replace("codebuddy.ps1", "other.ps1").split("\n"), "windows")).toBe("unknown");
  });

  it("checks and caches the Windows version before a confirmed update", async () => {
    const session = { id: "one", type: "windows", runtimeMode: "app-server", agentProvider: "codebuddy" };
    let version = "2.55.0";
    const { service, executeCommand, fetchLatest } = harness(session, () => windowsProbe(version));
    executeCommand.mockImplementation(async (_target, script) => {
      if (script.includes("npm.cmd install -g")) { version = "2.56.0"; return "updated"; }
      return windowsProbe(version);
    });
    expect(await service.check("one")).toMatchObject({ status: "available", method: "npm", environment: "windows" });
    expect(await service.check("one")).toMatchObject({ status: "available" });
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(await service.update("one")).toMatchObject({ status: "current", currentVersion: "2.56.0", restartRequired: true });
    expect(executeCommand.mock.calls.some(([, script]) => script.includes("npm.cmd install -g @tencent-ai/codebuddy-code@latest"))).toBe(true);
  });

  it("targets WSL and remote SSH separately", async () => {
    const session = { id: "wsl-1", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: "codebuddy" };
    const { service, executeCommand } = harness(session, () => linuxProbe("2.55.0"));
    expect(await service.check("wsl-1")).toMatchObject({ status: "available", environment: "wsl:Ubuntu" });
    session.type = "ssh"; session.agentLocation = "remote";
    expect(await service.check("wsl-1")).toMatchObject({ status: "available", environment: "ssh:wsl-1" });
    expect(executeCommand.mock.calls.every(([target]) => target.platform === "linux")).toBe(true);
  });

  it("uses Windows for local SSH bridge and rejects other providers", async () => {
    const session = { id: "bridge", type: "ssh", agentLocation: "local", runtimeMode: "app-server", agentProvider: "codebuddy" };
    const { service } = harness(session, () => windowsProbe("2.55.0"));
    expect(await service.check("bridge")).toMatchObject({ environment: "windows", method: "npm" });
    session.agentProvider = "codex";
    await expect(service.check("bridge")).rejects.toThrow("仅 CodeBuddy");
  });

  it("refuses to update an unknown installer", async () => {
    const session = { id: "remote", type: "ssh", agentLocation: "remote", runtimeMode: "app-server", agentProvider: "codebuddy" };
    const { service, executeCommand } = harness(session, () => linuxProbe("2.55.0", false));
    expect(await service.check("remote")).toMatchObject({ status: "available", method: "unknown" });
    await expect(service.update("remote")).rejects.toThrow("请先检测");
    expect(executeCommand).toHaveBeenCalledTimes(1);
  });

  it("re-probes and refuses an installation changed after checking", async () => {
    const session = { id: "one", type: "windows", runtimeMode: "app-server", agentProvider: "codebuddy" };
    let version = "2.55.0";
    const { service, executeCommand } = harness(session, () => windowsProbe(version));
    await service.check("one");
    version = "2.55.1";
    await expect(service.update("one")).rejects.toThrow("安装已变化");
    expect(executeCommand.mock.calls.some(([, script]) => script.includes("npm.cmd install -g"))).toBe(false);
  });

  it("reports a completed install that did not replace the active CLI", async () => {
    const session = { id: "one", type: "windows", runtimeMode: "app-server", agentProvider: "codebuddy" };
    const { service, executeCommand } = harness(session, () => windowsProbe("2.55.0"));
    await service.check("one");
    await expect(service.update("one")).rejects.toThrow("未切换到新版本");
    expect(executeCommand.mock.calls.some(([, script]) => script.includes("npm.cmd install -g"))).toBe(true);
  });
});
