import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCodexVersionService, installation, parseVersion, isNewer } = require("./version-service.cjs");

const windowsProbe = version => [
  `codex-cli ${version}`, "C:\\node\\codex.ps1", "C:\\node\\codex.ps1", "C:\\node\\node_modules",
  "C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin", "C:\\Users\\me\\.codex", "1", "0"
].join("\n");
const linuxProbe = (version, method = "npm") => [
  `codex-cli ${version}`, method === "npm" ? "/usr/local/bin/codex" : "/home/me/.local/bin/codex",
  method === "npm" ? "/usr/local/lib/node_modules/@openai/codex/bin/codex.js" : "/home/me/.local/bin/codex",
  "/usr/local/lib/node_modules", "/home/me/.local/bin", "/home/me/.codex", method === "npm" ? "1" : "0", method === "standalone" ? "1" : "0"
].join("\n");

function harness(session, output) {
  const executeCommand = vi.fn(async () => output());
  const fetchLatest = vi.fn(async () => ({ ok: true, json: async () => ({ version: "0.157.0" }) }));
  const service = createCodexVersionService({ terminalManager: { getSession: () => session }, executeCommand, fetchLatest });
  return { service, executeCommand, fetchLatest };
}

describe("Codex version updates", () => {
  it("compares stable versions and rejects an unrelated installation source", () => {
    expect(parseVersion("codex-cli 0.156.0").text).toBe("0.156.0");
    expect(isNewer(parseVersion("0.156.0"), parseVersion("0.157.0"))).toBe(true);
    expect(isNewer(parseVersion("0.157.0"), parseVersion("0.156.0"))).toBe(false);
    expect(installation(windowsProbe("0.156.0").split("\n"), "windows")).toBe("npm");
    expect(installation(linuxProbe("0.156.0", "standalone").split("\n"), "linux")).toBe("standalone");
    const unknown = linuxProbe("0.156.0", "standalone").split("\n");
    unknown[7] = "0";
    expect(installation(unknown, "linux")).toBe("unknown");
  });

  it("detects the Windows npm CLI and updates only after a separate call", async () => {
    const session = { id: "one", type: "windows", runtimeMode: "app-server", agentProvider: "codex" };
    let version = "0.156.0";
    const { service, executeCommand, fetchLatest } = harness(session, () => windowsProbe(version));
    executeCommand.mockImplementation(async (_target, script) => {
      if (script.includes("npm.cmd install -g")) { version = "0.157.0"; return "updated"; }
      return windowsProbe(version);
    });
    expect(await service.check("one")).toMatchObject({ status: "available", method: "npm", environment: "windows" });
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(await service.check("one")).toMatchObject({ status: "available" });
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(await service.update("one")).toMatchObject({ status: "current", currentVersion: "0.157.0", restartRequired: true });
    expect(executeCommand.mock.calls.some(([, script]) => script.includes("npm.cmd install -g @openai/codex@latest"))).toBe(true);
  });

  it("targets the WSL distribution and official standalone updater", async () => {
    const session = { id: "wsl-1", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: "codex" };
    let version = "0.156.0";
    const { service, executeCommand } = harness(session, () => linuxProbe(version, "standalone"));
    executeCommand.mockImplementation(async (_target, script) => {
      if (script.includes("install.sh")) { version = "0.157.0"; return "updated"; }
      return linuxProbe(version, "standalone");
    });
    expect(await service.check("wsl-1")).toMatchObject({ status: "available", method: "standalone", environment: "wsl:Ubuntu" });
    await service.update("wsl-1");
    expect(executeCommand.mock.calls.some(([target, script]) => target.session.wslDistro === "Ubuntu" && script.includes("CODEX_NON_INTERACTIVE=1 sh"))).toBe(true);
  });

  it("checks the SSH host and refuses an unknown installer", async () => {
    const session = { id: "ssh-1", type: "ssh", agentLocation: "remote", runtimeMode: "app-server", agentProvider: "codex" };
    const unknown = linuxProbe("0.156.0", "standalone").replace(/\n1$/, "\n0");
    const { service, executeCommand } = harness(session, () => unknown);
    expect(await service.check("ssh-1")).toMatchObject({ status: "available", method: "unknown", environment: "ssh:ssh-1" });
    await expect(service.update("ssh-1")).rejects.toThrow("请先检测");
    expect(executeCommand).toHaveBeenCalledTimes(1);
  });

  it("treats a local SSH bridge as a Windows installation and rejects other agents", async () => {
    const session = { id: "bridge", type: "ssh", agentLocation: "local", runtimeMode: "app-server", agentProvider: "codex" };
    const { service } = harness(session, () => windowsProbe("0.156.0"));
    expect(await service.check("bridge")).toMatchObject({ environment: "windows", method: "npm" });
    session.agentProvider = "codebuddy";
    await expect(service.check("bridge")).rejects.toThrow("仅 Codex");
  });
});
