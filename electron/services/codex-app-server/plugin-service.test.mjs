import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createCodexPluginService } = require("./plugin-service.cjs");

function harness(session = { id: "one", type: "windows", runtimeMode: "app-server", agentProvider: "codex", cwd: "C:\\project" }, outputs = []) {
  const calls = [];
  const spawnProcess = vi.fn((executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    queueMicrotask(() => { child.stdout.write(outputs.shift() || ""); child.stdout.end(); child.emit("close", 0); });
    return child;
  });
  const sshAgentTransport = { exec: vi.fn(async () => outputs.shift() || "") };
  const service = createCodexPluginService({ terminalManager: { getSession: () => session },
    graphicalService: { getWorkspaceCwd: () => session.cwd }, environmentService: { resolve: () => ({ CODEX_HOME: "/custom/codex" }) },
    sshAgentTransport, spawnProcess });
  return { service, calls, sshAgentTransport };
}

describe("Codex plugin service", () => {
  it("lists installed plugins from all sources and limits available plugins to configured marketplaces", async () => {
    const { service, calls } = harness(undefined, [
      JSON.stringify({ installed: [{ name: "demo", marketplaceName: "local", enabled: true }, { name: "remote", marketplaceName: "global" }],
        available: [{ name: "other", marketplaceName: "local" }] }),
      JSON.stringify({ marketplaces: [{ name: "local", path: "C:/plugins" }] })
    ]);
    const result = await service.list("one");
    expect(result.installed.map(plugin => plugin.name)).toEqual(["demo", "remote"]);
    expect(result.available.map(plugin => plugin.name)).toEqual(["other"]);
    expect(calls.every(call => call.executable === "powershell.exe")).toBe(true);
    expect(calls[0].args.at(-1)).toContain("'plugin' 'list' '--available' '--json'");
  });

  it("runs cmd startup commands in cmd before reading the plugin list and config", async () => {
    const session = { id: "cmd", type: "windows", shell: "cmd.exe", runtimeMode: "app-server",
      agentProvider: "codex", cwd: "C:\\project", initialCommand: 'chcp 65001 && set "HTTP_PROXY=http://127.0.0.1:7892"' };
    const { service, calls } = harness(session, [
      JSON.stringify({ installed: [], available: [] }), JSON.stringify({ marketplaces: [] }), ""
    ]);
    await service.list("cmd");
    await service.readConfig("cmd", "project");
    expect(calls.map(call => call.executable)).toEqual(["cmd.exe", "cmd.exe", "cmd.exe"]);
    for (const call of calls) {
      expect(call.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(call.args[3]).toContain(session.initialCommand);
      expect(call.args[3]).toContain("-EncodedCommand");
      expect(call.args[3]).not.toContain("& { chcp");
    }
  });

  it("routes WSL and SSH plugin commands to their own environments", async () => {
    const wsl = harness({ id: "w", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: "codex", cwd: "/home/me/project" }, [
      JSON.stringify({ installed: [], available: [] }), JSON.stringify({ marketplaces: [] })
    ]);
    await wsl.service.list("w");
    expect(wsl.calls[0].executable).toBe("wsl.exe");
    expect(wsl.calls[0].args).toContain("Ubuntu");
    expect(wsl.calls[0].args.at(-1)).toContain("cd '/home/me/project'");
    const ssh = harness({ id: "s", type: "ssh", agentLocation: "remote", runtimeMode: "app-server", agentProvider: "codex", cwd: "/srv/project" }, [
      JSON.stringify({ installed: [], available: [] }), JSON.stringify({ marketplaces: [] })
    ]);
    await ssh.service.list("s");
    expect(ssh.sshAgentTransport.exec).toHaveBeenCalledTimes(2);
    expect(ssh.sshAgentTransport.exec.mock.calls[0][1]).toContain("bash -lic");
  });

  it("preserves unrelated TOML settings when changing project plugin state", async () => {
    const existing = 'model = "gpt-6-sol"\n[plugins."demo@local"]\nother = "keep"\n';
    const { service, calls } = harness(undefined, [Buffer.from(existing).toString("base64"), ""]);
    const result = await service.setEnabled("one", "project", { plugin: "demo", marketplace: "local", enabled: false });
    expect(result.overrides["demo@local"]).toEqual({ enabled: false });
    const write = calls[1].args.at(-1);
    expect(write).toContain("Codex 配置已变化，请刷新后重试");
    expect(Buffer.from(write.match(/FromBase64String\('([^']+)'\)/)[1], "base64").toString()).toContain('model = "gpt-6-sol"');
  });

  it("rejects untrusted plugin selectors before invoking the CLI", async () => {
    const { service, calls } = harness();
    await expect(service.install("one", "--evil", "local")).rejects.toThrow("插件名无效");
    await expect(service.addMarketplace("one", "-c x=y")).rejects.toThrow("插件来源无效");
    expect(calls).toHaveLength(0);
  });

  (process.platform === "win32" ? it : it.skip)("writes only the chosen plugin state in a real project config", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-plugin-test-"));
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
    expect(relative && !relative.startsWith("..") && !path.isAbsolute(relative)).toBe(true);
    try {
      const configPath = path.join(root, ".codex", "config.toml");
      fs.mkdirSync(path.dirname(configPath));
      fs.writeFileSync(configPath, 'model = "gpt-6-sol"\n');
      const session = { id: "local", type: "windows", shell: "cmd.exe", runtimeMode: "app-server",
        agentProvider: "codex", cwd: root, initialCommand: 'chcp 65001 && set "PANNEL_PLUGIN_TEST=1"' };
      const service = createCodexPluginService({ terminalManager: { getSession: () => session },
        graphicalService: { getWorkspaceCwd: () => root }, environmentService: { resolve: () => ({}) } });
      await service.setEnabled("local", "project", { plugin: "review", marketplace: "team", enabled: false });
      const saved = fs.readFileSync(configPath, "utf8");
      expect(saved).toContain('model = "gpt-6-sol"');
      expect(saved).toContain('"review@team"');
      expect(saved).toContain("enabled = false");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
