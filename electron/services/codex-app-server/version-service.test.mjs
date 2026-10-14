import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const require = createRequire(import.meta.url);
const { createCodexVersionService, installation, parseVersion, isNewer, parseProbe } = require("./version-service.cjs");

function framedProbe(lines) {
  const keys = ["commandPath", "resolvedPath", "npmRoot", "installDir", "codexHome", "npmOwned", "standaloneOwned"];
  return ["__PANNEL_CODEX_PROBE_BEGIN__", "__PANNEL_CODEX_VERSION_BEGIN__", lines[0], "__PANNEL_CODEX_VERSION_END__",
    ...keys.map((key, index) => `${key}=${lines[index + 1]}`), "__PANNEL_CODEX_PROBE_END__"].join("\n");
}
const windowsProbe = version => framedProbe([
  `codex-cli ${version}`, "C:\\node\\codex.ps1", "C:\\node\\codex.ps1", "C:\\node\\node_modules",
  "C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin", "C:\\Users\\me\\.codex", "1", "0"
]);
const linuxProbe = (version, method = "npm") => framedProbe([
  `codex-cli ${version}`, method === "npm" ? "/usr/local/bin/codex" : "/home/me/.local/bin/codex",
  method === "npm" ? "/usr/local/lib/node_modules/@openai/codex/bin/codex.js" : "/home/me/.local/bin/codex",
  "/usr/local/lib/node_modules", "/home/me/.local/bin", "/home/me/.codex", method === "npm" ? "1" : "0", method === "standalone" ? "1" : "0"
]);

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
    expect(installation(parseProbe(windowsProbe("0.156.0")), "windows")).toBe("npm");
    expect(installation(parseProbe(linuxProbe("0.156.0", "standalone")), "linux")).toBe("standalone");
    const unknown = parseProbe(linuxProbe("0.156.0", "standalone"));
    unknown[7] = "0";
    expect(installation(unknown, "linux")).toBe("unknown");
  });

  it("executes probes and npm updates directly in WSL so the default shell cannot expand variables", async () => {
    const session = { id: "wsl-1", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: "codex" };
    let version = "0.156.0";
    const spawnProcess = vi.fn((_executable, args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      queueMicrotask(() => {
        if (args[5] === "npm install -g @openai/codex@latest") {
          version = "0.157.0";
          child.stdout.end("changed 2 packages");
        } else child.stdout.end(linuxProbe(version));
        child.emit("close", 0);
      });
      return child;
    });
    const service = createCodexVersionService({ terminalManager: { getSession: () => session }, spawnProcess,
      fetchLatest: async () => ({ ok: true, json: async () => ({ version: "0.157.0" }) }) });
    expect(await service.check("wsl-1")).toMatchObject({ currentVersion: "0.156.0", method: "npm" });
    expect(spawnProcess).toHaveBeenCalledWith("wsl.exe", ["-d", "Ubuntu", "--exec", "bash", "-lic", expect.stringContaining('"$version"')], expect.any(Object));
    expect(await service.update("wsl-1")).toMatchObject({ status: "current", currentVersion: "0.157.0", restartRequired: true });
    expect(spawnProcess).toHaveBeenCalledTimes(4);
    for (const [executable, args] of spawnProcess.mock.calls) {
      expect(executable).toBe("wsl.exe");
      expect(args.slice(0, 5)).toEqual(["-d", "Ubuntu", "--exec", "bash", "-lic"]);
    }
    expect(spawnProcess.mock.calls[2][1][5]).toBe("npm install -g @openai/codex@latest");
  });

  it("ignores shell startup versions and parses colored multiline Codex output", async () => {
    const session = { id: "wsl-1", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: "codex" };
    const output = "Welcome Ubuntu 24.04.1\n" + linuxProbe("0.156.0")
      .replace("codex-cli 0.156.0", "Notice: update helper 9.8.7\n\x1b[32mcodex-cli 0.156.0\x1b[0m") + "\nGoodbye 1.2.3";
    const { service } = harness(session, () => output);
    expect(await service.check("wsl-1")).toMatchObject({ currentVersion: "0.156.0", method: "npm", commandPath: "/usr/local/bin/codex" });
  });

  it("preserves an empty npm root for a standalone installation", async () => {
    const session = { id: "wsl-1", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: "codex" };
    const { service } = harness(session, () => linuxProbe("0.156.0", "standalone").replace("npmRoot=/usr/local/lib/node_modules", "npmRoot="));
    expect(await service.check("wsl-1")).toMatchObject({ currentVersion: "0.156.0", method: "standalone" });
  });

  it.each([
    [linuxProbe("0.156.0").replace("__PANNEL_CODEX_PROBE_END__", ""), "返回内容不完整"],
    [linuxProbe("0.156.0").replace("resolvedPath=/usr/local/lib/node_modules/@openai/codex/bin/codex.js\n", ""), "返回内容不完整"],
    ["Welcome 24.04.1\n" + linuxProbe("0.156.0").replace("codex-cli 0.156.0", "unrecognized version; helper 9.8.7"), "无法识别 Codex CLI 版本"],
    [linuxProbe("0.156.0").replace("commandPath=/usr/local/bin/codex", "commandPath="), "返回内容不完整"]
  ])("reports invalid probe output without guessing a version", async (output, error) => {
    const session = { id: "wsl-1", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: "codex" };
    const { service } = harness(session, () => output);
    expect(await service.check("wsl-1")).toMatchObject({ status: "error", error: expect.stringContaining(error) });
  });

  it.each(["Codex CLI 命令不存在。", "Codex CLI 版本命令执行失败。", "Codex 版本命令超时。"])("preserves probe command failures", async error => {
    const session = { id: "wsl-1", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: "codex" };
    const { service, executeCommand } = harness(session, () => "");
    executeCommand.mockRejectedValue(new Error(error));
    expect(await service.check("wsl-1")).toMatchObject({ status: "error", error });
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
    const unknown = linuxProbe("0.156.0", "standalone").replace("standaloneOwned=1", "standaloneOwned=0");
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

  it("requires another confirmation when the SSH resolved installation changes", async () => {
    const session = { id: "ssh-1", type: "ssh", agentLocation: "remote", runtimeMode: "app-server", agentProvider: "codex" };
    let commandPath = "/usr/local/bin/codex";
    let version = "0.156.0";
    const output = () => linuxProbe(version).replace("/usr/local/bin/codex", commandPath)
      .replaceAll("/usr/local/lib/node_modules", `${commandPath.slice(0, -"/bin/codex".length)}/lib/node_modules`);
    const { service, executeCommand } = harness(session, output);
    executeCommand.mockImplementation(async (_target, script) => {
      if (script.includes("npm install -g")) { version = "0.157.0"; return "updated"; }
      return output();
    });
    await service.check("ssh-1");
    commandPath = "/opt/node/bin/codex";
    expect(await service.update("ssh-1")).toMatchObject({ status: "available", commandPath });
    expect(executeCommand.mock.calls.some(([, script]) => script.includes("npm install -g"))).toBe(false);
    expect(await service.update("ssh-1")).toMatchObject({ status: "current", currentVersion: "0.157.0", restartRequired: true });
  });

  it("updates SSH npm installations when fnm changes the command symlink on every probe", async () => {
    const session = { id: "ssh-1", type: "ssh", agentLocation: "remote", runtimeMode: "app-server", agentProvider: "codex" };
    let version = "0.156.0";
    let shell = 0;
    const { service, executeCommand } = harness(session, () => "");
    executeCommand.mockImplementation(async (_target, script) => {
      if (script === "npm install -g @openai/codex@latest") { version = "0.157.0"; return "updated"; }
      return linuxProbe(version).replace("/usr/local/bin/codex", `/run/user/0/fnm_multishells/${++shell}/bin/codex`);
    });
    expect(await service.check("ssh-1")).toMatchObject({ status: "available", method: "npm" });
    expect(await service.update("ssh-1")).toMatchObject({ status: "current", currentVersion: "0.157.0", restartRequired: true });
    expect(executeCommand.mock.calls.filter(([, script]) => script === "npm install -g @openai/codex@latest")).toHaveLength(1);
    expect(shell).toBe(3);
  });

  it("shows manual guidance when the SSH installation source changes", async () => {
    const session = { id: "ssh-1", type: "ssh", agentLocation: "remote", runtimeMode: "app-server", agentProvider: "codex" };
    let output = linuxProbe("0.156.0");
    const { service, executeCommand } = harness(session, () => output);
    await service.check("ssh-1");
    output = linuxProbe("0.156.0", "standalone").replace("standaloneOwned=1", "standaloneOwned=0");
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
