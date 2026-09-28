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

  it("refreshes an SSH installation that reached the latest version before confirmation", async () => {
    const session = { id: "ssh-1", type: "ssh", agentLocation: "remote", runtimeMode: "app-server", agentProvider: "codex" };
    let version = "0.156.0";
    const { service, executeCommand } = harness(session, () => linuxProbe(version));
    expect(await service.check("ssh-1")).toMatchObject({ status: "available", currentVersion: "0.156.0" });
    version = "0.157.0";
    expect(await service.update("ssh-1")).toMatchObject({ status: "current", currentVersion: "0.157.0" });
    expect(await service.check("ssh-1")).toMatchObject({ status: "current", currentVersion: "0.157.0" });
    expect(executeCommand).toHaveBeenCalledTimes(2);
  });

  it("requires another confirmation when the SSH version changes but remains outdated", async () => {
    const session = { id: "ssh-1", type: "ssh", agentLocation: "remote", runtimeMode: "app-server", agentProvider: "codex" };
    let version = "0.156.0";
    const { service, executeCommand } = harness(session, () => linuxProbe(version));
    executeCommand.mockImplementation(async (_target, script) => {
      if (script.includes("npm install -g")) { version = "0.157.0"; return "updated"; }
      return linuxProbe(version);
    });
    await service.check("ssh-1");
    version = "0.156.1";
    expect(await service.update("ssh-1")).toMatchObject({ status: "available", currentVersion: "0.156.1" });
    expect(executeCommand.mock.calls.some(([, script]) => script.includes("npm install -g"))).toBe(false);
    expect(await service.update("ssh-1")).toMatchObject({ status: "current", currentVersion: "0.157.0", restartRequired: true });
  });

  it("requires another confirmation when the SSH command path changes", async () => {
    const session = { id: "ssh-1", type: "ssh", agentLocation: "remote", runtimeMode: "app-server", agentProvider: "codex" };
    let commandPath = "/usr/local/bin/codex";
    let version = "0.156.0";
    const { service, executeCommand } = harness(session, () => linuxProbe(version).replace("/usr/local/bin/codex", commandPath));
    executeCommand.mockImplementation(async (_target, script) => {
      if (script.includes("npm install -g")) { version = "0.157.0"; return "updated"; }
      return linuxProbe(version).replace("/usr/local/bin/codex", commandPath);
    });
    await service.check("ssh-1");
    commandPath = "/opt/node/bin/codex";
    expect(await service.update("ssh-1")).toMatchObject({ status: "available", commandPath });
    expect(executeCommand.mock.calls.some(([, script]) => script.includes("npm install -g"))).toBe(false);
    expect(await service.update("ssh-1")).toMatchObject({ status: "current", currentVersion: "0.157.0", restartRequired: true });
  });

  it("shows manual guidance when the SSH installation source changes", async () => {
    const session = { id: "ssh-1", type: "ssh", agentLocation: "remote", runtimeMode: "app-server", agentProvider: "codex" };
    let output = linuxProbe("0.156.0");
    const { service, executeCommand } = harness(session, () => output);
    await service.check("ssh-1");
    output = linuxProbe("0.156.0", "standalone").replace(/\n1$/, "\n0");
    expect(await service.update("ssh-1")).toMatchObject({ status: "available", method: "unknown",
      guidance: "请使用该环境原有的安装方式手动更新 Codex。" });
    await expect(service.update("ssh-1")).rejects.toThrow("请先检测");
    expect(executeCommand).toHaveBeenCalledTimes(2);
  });

  it("does not let an older SSH check overwrite the result of an update", async () => {
    const session = { id: "ssh-1", type: "ssh", agentLocation: "remote", runtimeMode: "app-server", agentProvider: "codex" };
    let version = "0.156.0";
    let finishCheck;
    let probes = 0;
    const { service, executeCommand } = harness(session, () => linuxProbe(version));
    executeCommand.mockImplementation(async (_target, script) => {
      if (script.includes("npm install -g")) { version = "0.157.0"; return "updated"; }
      probes += 1;
      if (probes === 2) return new Promise(resolve => { finishCheck = () => resolve(linuxProbe("0.156.0")); });
      return linuxProbe(version);
    });
    await service.check("ssh-1");
    const olderCheck = service.check("ssh-1", true);
    await vi.waitFor(() => expect(finishCheck).toBeTypeOf("function"));
    expect(await service.update("ssh-1")).toMatchObject({ status: "current", currentVersion: "0.157.0" });
    finishCheck();
    expect(await olderCheck).toMatchObject({ status: "current", currentVersion: "0.157.0" });
    expect(await service.check("ssh-1")).toMatchObject({ status: "current", currentVersion: "0.157.0" });
  });

  it("treats a local SSH bridge as a Windows installation and rejects other agents", async () => {
    const session = { id: "bridge", type: "ssh", agentLocation: "local", runtimeMode: "app-server", agentProvider: "codex" };
    const { service } = harness(session, () => windowsProbe("0.156.0"));
    expect(await service.check("bridge")).toMatchObject({ environment: "windows", method: "npm" });
    session.agentProvider = "codebuddy";
    await expect(service.check("bridge")).rejects.toThrow("仅 Codex");
  });

  it("exposes installation output across sessions in the same environment", async () => {
    const session = { id: "one", type: "windows", runtimeMode: "app-server", agentProvider: "codex" };
    let version = "0.156.0";
    let finishInstall;
    const { service, executeCommand } = harness(session, () => windowsProbe(version));
    executeCommand.mockImplementation(async (_target, script, _timeout, onOutput) => {
      if (!script.includes("npm.cmd install -g")) return windowsProbe(version);
      onOutput("Token: secr");
      onOutput("et-value\nadded 1 package");
      return new Promise(resolve => { finishInstall = () => { version = "0.157.0"; resolve("updated"); }; });
    });
    await service.check("one");
    const pending = service.update("one");
    await vi.waitFor(() => expect(finishInstall).toBeTypeOf("function"));
    session.id = "two";
    const during = await service.check("two");
    expect(during).toMatchObject({ status: "updating", progress: { stage: "installing" } });
    expect(during.progress.output).toContain("added 1 package");
    expect(during.progress.output).not.toContain("secret-value");
    await expect(service.update("two")).rejects.toThrow("正在更新");
    finishInstall();
    await pending;
    expect(await service.check("two")).toMatchObject({ status: "current", restartRequired: true,
      progress: { stage: "complete" } });
  });
});
