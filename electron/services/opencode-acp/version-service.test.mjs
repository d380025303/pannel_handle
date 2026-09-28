import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOpenCodeVersionService, installation } = require("./version-service.cjs");

const windowsProbe = (version, owned = true) => [
  `opencode v${version}`, "C:\\node\\opencode.ps1", "C:\\node\\opencode.ps1",
  "C:\\node\\node_modules", owned ? "1" : "0"
].join("\n");
const linuxProbe = (version, owned = true) => [
  `opencode v${version}`, "/usr/local/bin/opencode",
  owned ? "/usr/local/lib/node_modules/@opencode/cli/bin/opencode" : "/opt/opencode/bin/opencode",
  "/usr/local/lib/node_modules", owned ? "1" : "0"
].join("\n");

function harness(session, output) {
  const executeCommand = vi.fn(async () => output());
  const fetchLatest = vi.fn(async () => ({ ok: true, json: async () => ({ version: "2.0.19" }) }));
  const service = createOpenCodeVersionService({
    terminalManager: { getSession: () => session }, executeCommand, fetchLatest
  });
  return { service, executeCommand, fetchLatest };
}

describe("OpenCode V2 version updates", () => {
  it("recognizes only the active V2 npm installation", () => {
    expect(installation(windowsProbe("2.0.18").split("\n"), "windows")).toBe("npm");
    expect(installation(linuxProbe("2.0.18").split("\n"), "linux")).toBe("npm");
    expect(installation(linuxProbe("2.0.18", false).split("\n"), "linux")).toBe("unknown");
    expect(installation(windowsProbe("2.0.18", false).split("\n"), "windows")).toBe("unknown");
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
