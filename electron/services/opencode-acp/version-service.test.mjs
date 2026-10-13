import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOpenCodeVersionService, installation } = require("./version-service.cjs");

function framedProbe(lines) {
  const keys = ["commandPath", "resolvedPath", "npmRoot", "npmOwned"];
  return ["__PANNEL_OPENCODE_PROBE_BEGIN__", "__PANNEL_OPENCODE_VERSION_BEGIN__", lines[0], "__PANNEL_OPENCODE_VERSION_END__",
    ...keys.map((key, index) => `${key}=${lines[index + 1]}`), "__PANNEL_OPENCODE_PROBE_END__"].join("\n");
}
function probeLines(output) {
  const { parseCliProbe } = require("../cli-version-probe.cjs");
  return parseCliProbe(output, { marker: "OPENCODE", keys: ["commandPath", "resolvedPath", "npmRoot", "npmOwned"] });
}

const windowsProbe = (version, owned = true) => framedProbe([
  `opencode v${version}`, "C:\\node\\opencode.ps1", "C:\\node\\opencode.ps1",
  "C:\\node\\node_modules", owned ? "1" : "0"
]);
const linuxProbe = (version, owned = true) => framedProbe([
  `opencode v${version}`, "/usr/local/bin/opencode",
  owned ? "/usr/local/lib/node_modules/@opencode/cli/bin/opencode" : "/opt/opencode/bin/opencode",
  "/usr/local/lib/node_modules", owned ? "1" : "0"
]);

function harness(session, output) {
  const executeCommand = vi.fn(async () => output());
  const fetchLatest = vi.fn(async () => ({ ok: true, json: async () => ({ version: "2.0.19" }) }));
  const service = createOpenCodeVersionService({
    terminalManager: { getSession: () => session }, executeCommand, fetchLatest
  });
  return { service, executeCommand, fetchLatest };
}

describe("OpenCode V2 version updates", () => {
  it.each(["windows", "wsl", "ssh"])("ignores startup and trailing output in %s probes", async type => {
    const session = { id: "one", type, wslDistro: "Ubuntu", agentLocation: "remote", runtimeMode: "app-server", agentProvider: "opencode" };
    const clean = type === "windows" ? windowsProbe("2.0.19") : linuxProbe("2.0.19");
    for (const output of [clean, "Welcome to workspace 9.8.7\n" + clean, clean + "\nGoodbye 9.8.7",
      "Welcome to workspace\n" + clean.split("\n").map(line => `\x1b[32m${line}\x1b[0m`).join("\r\n") + "\nGoodbye",
      clean.replace("opencode v2.0.19", "\x1b]0;CLI title\x07opencode v2.0.19")]) {
      const { service, executeCommand } = harness(session, () => output);
      expect(await service.check("one")).toMatchObject({ status: "current", currentVersion: "2.0.19", method: "npm",
        commandPath: type === "windows" ? "C:\\node\\opencode.ps1" : "/usr/local/bin/opencode" });
      const script = executeCommand.mock.calls[0][1];
      for (const token of ["__PANNEL_OPENCODE_PROBE_BEGIN__", "__PANNEL_OPENCODE_VERSION_BEGIN__", "__PANNEL_OPENCODE_VERSION_END__", "__PANNEL_OPENCODE_PROBE_END__", "commandPath=", "resolvedPath=", "npmRoot=", "npmOwned="])
        expect(script).toContain(token);
    }
  });

  it.each([
    output => output.replace("__PANNEL_OPENCODE_PROBE_BEGIN__", ""),
    output => output.replace("__PANNEL_OPENCODE_PROBE_END__", ""),
    output => output.replace("__PANNEL_OPENCODE_VERSION_BEGIN__", ""),
    output => output.replace("__PANNEL_OPENCODE_VERSION_END__", ""),
    output => output.replace(/^resolvedPath=.*\n/m, ""),
    output => output.replace(/^npmRoot=.*\n/m, ""),
    output => output.replace(/^npmOwned=.*\n/m, ""),
    output => output.replace(/^commandPath=.*$/m, "commandPath="),
    output => output.replace("npmOwned=1", "npmOwned=1\nnpmOwned=0"),
    () => "Welcome to workspace\nopencode v2.0.19\n/usr/local/bin/opencode",
  ])("rejects missing markers and incomplete or ambiguous fields", async damage => {
    const session = { id: "one", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: "opencode" };
    const { service } = harness(session, () => damage(linuxProbe("2.0.19")));
    expect(await service.check("one")).toMatchObject({ status: "error", error: expect.stringContaining("返回内容不完整") });
  });

  it("preserves empty npm metadata and unknown installation ownership with noisy output", async () => {
    const session = { id: "one", type: "ssh", agentLocation: "remote", runtimeMode: "app-server", agentProvider: "opencode" };
    const { service } = harness(session, () => "Welcome\n" + linuxProbe("2.0.19", false).replace("npmRoot=/usr/local/lib/node_modules", "npmRoot=") + "\nGoodbye");
    expect(await service.check("one")).toMatchObject({ status: "current", currentVersion: "2.0.19", commandPath: "/usr/local/bin/opencode", method: "unknown" });
  });

  it("does not use a welcome version when the version block is invalid", async () => {
    const session = { id: "one", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: "opencode" };
    const { service } = harness(session, () => "Welcome 9.8.7\n" + linuxProbe("2.0.19").replace("opencode v2.0.19", "unrecognized"));
    expect(await service.check("one")).toMatchObject({ status: "error", error: expect.stringContaining("V2 CLI") });
  });

  it("updates a WSL npm installation despite welcome and logout output", async () => {
    const session = { id: "one", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: "opencode" };
    let version = "2.0.18";
    const noisyProbe = () => "Welcome to workspace\n" + linuxProbe(version) + "\nGoodbye";
    const { service, executeCommand } = harness(session, noisyProbe);
    executeCommand.mockImplementation(async (_target, script) => {
      if (script === "npm install -g @opencode/cli@latest") { version = "2.0.19"; return "updated"; }
      return noisyProbe();
    });
    expect(await service.check("one")).toMatchObject({ status: "available", currentVersion: "2.0.18", method: "npm" });
    expect(await service.update("one")).toMatchObject({ status: "current", currentVersion: "2.0.19", method: "npm", restartRequired: true });
  });

  it("recognizes only the active V2 npm installation", () => {
    expect(installation(probeLines(windowsProbe("2.0.18")), "windows")).toBe("npm");
    expect(installation(probeLines(linuxProbe("2.0.18")), "linux")).toBe("npm");
    expect(installation(probeLines(linuxProbe("2.0.18", false)), "linux")).toBe("unknown");
    expect(installation(probeLines(windowsProbe("2.0.18", false)), "windows")).toBe("unknown");
  });

  it("checks and updates Windows npm after confirmation, then verifies the active command", async () => {
    const session = { id: "one", type: "windows", runtimeMode: "app-server", agentProvider: "opencode" };
    let version = "2.0.18";
    const { service, executeCommand, fetchLatest } = harness(session, () => windowsProbe(version));
    executeCommand.mockImplementation(async (_target, script) => {
      if (script.includes("npm.cmd install -g")) { version = "2.0.19"; return "updated"; }
      return windowsProbe(version);
    });
    expect(await service.check("one")).toMatchObject({ status: "available", method: "npm", environment: "windows" });
    expect(await service.check("one")).toMatchObject({ status: "available" });
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(await service.update("one")).toMatchObject({ status: "current", currentVersion: "2.0.19", restartRequired: true });
    expect(executeCommand.mock.calls.some(([, script]) => script.includes("npm.cmd install -g @opencode/cli@latest"))).toBe(true);
  });

  it("uses the selected WSL or remote SSH environment, and the local bridge for local SSH", async () => {
    const session = { id: "one", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: "opencode" };
    const { service, executeCommand } = harness(session, () => linuxProbe("2.0.18"));
    expect(await service.check("one")).toMatchObject({ environment: "wsl:Ubuntu", method: "npm" });
    session.type = "ssh"; session.agentLocation = "remote";
    expect(await service.check("one")).toMatchObject({ environment: "ssh:one", method: "npm" });
    expect(executeCommand.mock.calls.every(([target]) => target.platform === "linux")).toBe(true);
    session.agentLocation = "local";
    executeCommand.mockResolvedValueOnce(windowsProbe("2.0.18"));
    expect(await service.check("one")).toMatchObject({ environment: "windows", method: "npm" });
  });

  it("rejects V1 and unrelated providers", async () => {
    const session = { id: "one", type: "windows", runtimeMode: "app-server", agentProvider: "opencode" };
    const { service } = harness(session, () => windowsProbe("1.18.33"));
    expect(await service.check("one")).toMatchObject({ status: "error", error: expect.stringContaining("V2 CLI") });
    session.agentProvider = "codex";
    await expect(service.check("one")).rejects.toThrow("仅 OpenCode");
  });

  it("keeps unknown installations manual and refuses a changed installation", async () => {
    const session = { id: "one", type: "windows", runtimeMode: "app-server", agentProvider: "opencode" };
    let version = "2.0.18";
    const { service, executeCommand } = harness(session, () => windowsProbe(version, false));
    expect(await service.check("one")).toMatchObject({ status: "available", method: "unknown", guidance: expect.stringContaining("手动更新") });
    await expect(service.update("one")).rejects.toThrow("请先检测");
    executeCommand.mockImplementation(async () => windowsProbe(version));
    await service.check("one", true);
    version = "2.0.18-beta.1";
    await expect(service.update("one")).rejects.toThrow("安装已变化");
    expect(executeCommand.mock.calls.some(([, script]) => script.includes("npm.cmd install -g"))).toBe(false);
  });

  it("retains update progress and failure for another session in the same environment", async () => {
    const session = { id: "one", type: "windows", runtimeMode: "app-server", agentProvider: "opencode" };
    let failInstall;
    const { service, executeCommand } = harness(session, () => windowsProbe("2.0.18"));
    executeCommand.mockImplementation(async (_target, script, _timeout, onOutput) => {
      if (!script.includes("npm.cmd install -g")) return windowsProbe("2.0.18");
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
    expect(await service.check("two")).toMatchObject({ status: "error", error: "安装失败", progress: { stage: "failed" } });
  });
});
