import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCodeBuddyVersionService, installation } = require("./version-service.cjs");

function framedProbe(lines) {
  const keys = ["commandPath", "resolvedPath", "npmRoot", "npmOwned"];
  return ["__PANNEL_CODEBUDDY_PROBE_BEGIN__", "__PANNEL_CODEBUDDY_VERSION_BEGIN__", lines[0], "__PANNEL_CODEBUDDY_VERSION_END__",
    ...keys.map((key, index) => `${key}=${lines[index + 1]}`), "__PANNEL_CODEBUDDY_PROBE_END__"].join("\n");
}
function probeLines(output) {
  const { parseCliProbe } = require("../cli-version-probe.cjs");
  return parseCliProbe(output, { marker: "CODEBUDDY", keys: ["commandPath", "resolvedPath", "npmRoot", "npmOwned"] });
}

const windowsProbe = version => framedProbe([
  `codebuddy ${version}`, "C:\\node\\codebuddy.ps1", "C:\\node\\codebuddy.ps1",
  "C:\\node\\node_modules", "1"
]);
const linuxProbe = (version, owned = true) => framedProbe([
  `codebuddy ${version}`, "/usr/local/bin/codebuddy",
  owned ? "/usr/local/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy.js" : "/opt/codebuddy/bin/codebuddy",
  "/usr/local/lib/node_modules", owned ? "1" : "0"
]);

function harness(session, output) {
  const executeCommand = vi.fn(async () => output());
  const fetchLatest = vi.fn(async () => ({ ok: true, json: async () => ({ version: "2.56.0" }) }));
  const service = createCodeBuddyVersionService({ terminalManager: { getSession: () => session }, executeCommand, fetchLatest });
  return { service, executeCommand, fetchLatest };
}

describe("CodeBuddy version updates", () => {
  it.each(["windows", "wsl", "ssh"])("ignores startup and trailing output in %s probes", async type => {
    const session = { id: "one", type, wslDistro: "Ubuntu", agentLocation: "remote", runtimeMode: "app-server", agentProvider: "codebuddy" };
    const clean = type === "windows" ? windowsProbe("2.56.0") : linuxProbe("2.56.0");
    for (const output of [clean, "Welcome to workspace 9.8.7\n" + clean, clean + "\nGoodbye 9.8.7",
      "Welcome to workspace\n" + clean.split("\n").map(line => `\x1b[32m${line}\x1b[0m`).join("\r\n") + "\nGoodbye",
      clean.replace("codebuddy 2.56.0", "\x1b]0;CLI title\x07codebuddy 2.56.0")]) {
      const { service, executeCommand } = harness(session, () => output);
      expect(await service.check("one")).toMatchObject({ status: "current", currentVersion: "2.56.0", method: "npm",
        commandPath: type === "windows" ? "C:\\node\\codebuddy.ps1" : "/usr/local/bin/codebuddy" });
      const script = executeCommand.mock.calls[0][1];
      for (const token of ["__PANNEL_CODEBUDDY_PROBE_BEGIN__", "__PANNEL_CODEBUDDY_VERSION_BEGIN__", "__PANNEL_CODEBUDDY_VERSION_END__", "__PANNEL_CODEBUDDY_PROBE_END__", "commandPath=", "resolvedPath=", "npmRoot=", "npmOwned="])
        expect(script).toContain(token);
    }
  });

  it.each([
    output => output.replace("__PANNEL_CODEBUDDY_PROBE_BEGIN__", ""),
    output => output.replace("__PANNEL_CODEBUDDY_PROBE_END__", ""),
    output => output.replace("__PANNEL_CODEBUDDY_VERSION_BEGIN__", ""),
    output => output.replace("__PANNEL_CODEBUDDY_VERSION_END__", ""),
    output => output.replace(/^resolvedPath=.*\n/m, ""),
    output => output.replace(/^npmRoot=.*\n/m, ""),
    output => output.replace(/^npmOwned=.*\n/m, ""),
    output => output.replace(/^commandPath=.*$/m, "commandPath="),
    output => output.replace("npmOwned=1", "npmOwned=1\nnpmOwned=0"),
    () => "Welcome to workspace\ncodebuddy 2.56.0\n/usr/local/bin/codebuddy",
  ])("rejects missing markers and incomplete or ambiguous fields", async damage => {
    const session = { id: "one", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: "codebuddy" };
    const { service } = harness(session, () => damage(linuxProbe("2.56.0")));
    expect(await service.check("one")).toMatchObject({ status: "error", error: expect.stringContaining("返回内容不完整") });
  });

  it("preserves empty npm metadata and unknown installation ownership with noisy output", async () => {
    const session = { id: "one", type: "ssh", agentLocation: "remote", runtimeMode: "app-server", agentProvider: "codebuddy" };
    const { service } = harness(session, () => "Welcome\n" + linuxProbe("2.56.0", false).replace("npmRoot=/usr/local/lib/node_modules", "npmRoot=") + "\nGoodbye");
    expect(await service.check("one")).toMatchObject({ status: "current", currentVersion: "2.56.0", commandPath: "/usr/local/bin/codebuddy", method: "unknown" });
  });

  it("does not use a welcome version when the version block is invalid", async () => {
    const session = { id: "one", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: "codebuddy" };
    const { service } = harness(session, () => "Welcome 9.8.7\n" + linuxProbe("2.56.0").replace("codebuddy 2.56.0", "unrecognized"));
    expect(await service.check("one")).toMatchObject({ status: "error", error: expect.stringContaining("无法识别 CodeBuddy CLI 版本") });
  });

  it("updates a WSL npm installation despite welcome and logout output", async () => {
    const session = { id: "one", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: "codebuddy" };
    let version = "2.55.0";
    const noisyProbe = () => "Welcome to workspace\n" + linuxProbe(version) + "\nGoodbye";
    const { service, executeCommand } = harness(session, noisyProbe);
    executeCommand.mockImplementation(async (_target, script) => {
      if (script === "npm install -g @tencent-ai/codebuddy-code@latest") { version = "2.56.0"; return "updated"; }
      return noisyProbe();
    });
    expect(await service.check("one")).toMatchObject({ status: "available", currentVersion: "2.55.0", method: "npm" });
    expect(await service.update("one")).toMatchObject({ status: "current", currentVersion: "2.56.0", method: "npm", restartRequired: true });
  });

  it("recognizes only the active npm installation", () => {
    expect(installation(probeLines(windowsProbe("2.55.0")), "windows")).toBe("npm");
    expect(installation(probeLines(linuxProbe("2.55.0")), "linux")).toBe("npm");
    expect(installation(probeLines(linuxProbe("2.55.0", false)), "linux")).toBe("unknown");
    expect(installation(probeLines(windowsProbe("2.55.0").replace("codebuddy.ps1", "other.ps1")), "windows")).toBe("unknown");
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

  it("retains installation progress and failure after leaving the session", async () => {
    const session = { id: "one", type: "windows", runtimeMode: "app-server", agentProvider: "codebuddy" };
    let failInstall;
    const { service, executeCommand } = harness(session, () => windowsProbe("2.55.0"));
    executeCommand.mockImplementation(async (_target, script, _timeout, onOutput) => {
      if (!script.includes("npm.cmd install -g")) return windowsProbe("2.55.0");
      onOutput("npm error details");
      return new Promise((_resolve, reject) => { failInstall = () => reject(new Error("安装失败")); });
    });
    await service.check("one");
    const pending = service.update("one");
    await vi.waitFor(() => expect(failInstall).toBeTypeOf("function"));
    session.id = "two";
    expect(await service.check("two")).toMatchObject({ status: "updating", progress: { stage: "installing", output: "npm error details" } });
    failInstall();
    await expect(pending).rejects.toThrow("安装失败");
    expect(await service.check("two")).toMatchObject({ status: "error", error: "安装失败",
      progress: { stage: "failed", output: "npm error details" } });
  });
});
