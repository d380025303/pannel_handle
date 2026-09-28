import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createCodexPluginService } = require("./plugin-service.cjs");

function harness(session = { id: "one", type: "windows", runtimeMode: "app-server", agentProvider: "codex", cwd: "C:\\project" }, outputs = []) {
  const calls = [];
  const spawnProcess = vi.fn((executable, args, options) => {
    const call = { executable, args, options, input: "" };
    calls.push(call);
    const child = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdin.end = vi.fn(input => { call.input = input; });
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
  it("uses the active App Server account catalog for graphical sessions", async () => {
    const session = { id: "one", type: "windows", runtimeMode: "app-server", agentProvider: "codex", cwd: "C:\\project" };
    const graphicalService = { getWorkspaceCwd: () => session.cwd,
      listPlugins: vi.fn(async () => ({ marketplaces: [{ name: "official", path: null, plugins: [
        { id: "figma@official", name: "figma", marketplaceName: "official", installed: true, enabled: true },
        { id: "github@official", name: "github", marketplaceName: "official", installed: false, enabled: false }
      ] }], errors: [] })), installPlugin: vi.fn(async () => {}), uninstallPlugin: vi.fn(async () => {}) };
    const spawnProcess = vi.fn();
    const service = createCodexPluginService({ terminalManager: { getSession: () => session }, graphicalService,
      environmentService: { resolve: () => ({}) }, spawnProcess });
    const catalog = await service.list("one");
    expect(catalog.installed.map(item => item.name)).toEqual(["figma"]);
    expect(catalog.available.map(item => item.name)).toEqual(["github"]);
    await service.install("one", "github", "official");
    await service.uninstall("one", "figma", "official");
    expect(graphicalService.installPlugin).toHaveBeenCalledWith("one", expect.objectContaining({ name: "github" }));
    expect(graphicalService.uninstallPlugin).toHaveBeenCalledWith("one", "figma@official");
    expect(spawnProcess).not.toHaveBeenCalled();
  });
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
    expect(calls[1].args.at(-1)).toContain("Codex 配置已变化，请刷新后重试");
    expect(calls[1].options.stdio[0]).toBe("pipe");
    const [expected, next] = calls[1].input.trimEnd().split("\n");
    expect(Buffer.from(expected, "base64").toString()).toBe(existing);
    expect(Buffer.from(next, "base64").toString()).toContain('model = "gpt-6-sol"');
  });

  it("keeps large project and user configs out of Windows process arguments", async () => {
    const existing = `# ${"a".repeat(50000)}\nmodel = "gpt-6-sol"\n`;
    const encoded = Buffer.from(existing).toString("base64");
    const { service, calls } = harness(undefined, [encoded, "", encoded, ""]);
    await service.setEnabled("one", "project", { plugin: "demo", marketplace: "local", enabled: true });
    await service.setEnabled("one", "user", { plugin: "demo", marketplace: "local", enabled: false });
    for (const call of [calls[1], calls[3]]) {
      expect(call.args.join(" ").length).toBeLessThan(4000);
      expect(call.input.length).toBeGreaterThan(60000);
      expect(call.input.split("\n")[0]).toBe(encoded);
    }
  });

  it("sends WSL and SSH config writes through stdin", async () => {
    const wsl = harness({ id: "w", type: "wsl", wslDistro: "Ubuntu", runtimeMode: "app-server", agentProvider: "codex", cwd: "/home/me/project" }, ["", ""]);
    await wsl.service.setEnabled("w", "project", { plugin: "demo", marketplace: "local", enabled: true });
    expect(wsl.calls[1].options.stdio[0]).toBe("pipe");
    expect(wsl.calls[1].args.at(-1)).toContain("read -r expected");
    expect(wsl.calls[1].input).toContain("\n");
    const ssh = harness({ id: "s", type: "ssh", agentLocation: "remote", runtimeMode: "app-server", agentProvider: "codex", cwd: "/srv/project" }, ["", ""]);
    await ssh.service.setEnabled("s", "user", { plugin: "demo", marketplace: "local", enabled: false });
    expect(ssh.sshAgentTransport.exec.mock.calls[1][1]).toContain("read -r expected");
    expect(ssh.sshAgentTransport.exec.mock.calls[1][2].stdin).toContain("\n");
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
      fs.writeFileSync(configPath, `# ${"a".repeat(50000)}\nmodel = "gpt-6-sol"\n`);
      const session = { id: "local", type: "windows", shell: "cmd.exe", runtimeMode: "app-server",
        agentProvider: "codex", cwd: root, initialCommand: 'chcp 65001 && set "PANNEL_PLUGIN_TEST=1"' };
      const service = createCodexPluginService({ terminalManager: { getSession: () => session },
        graphicalService: { getWorkspaceCwd: () => root }, environmentService: { resolve: () => ({}) } });
      await service.setEnabled("local", "project", { plugin: "review", marketplace: "team", enabled: false });
      const saved = fs.readFileSync(configPath, "utf8");
      expect(saved).toContain('model = "gpt-6-sol"');
      expect(saved).toContain('"review@team"');
      expect(saved).toContain("enabled = false");
      let commands = 0;
      const conflictService = createCodexPluginService({ terminalManager: { getSession: () => session },
        graphicalService: { getWorkspaceCwd: () => root }, environmentService: { resolve: () => ({}) },
        spawnProcess: (executable, args, options) => {
          if (++commands === 2) fs.appendFileSync(configPath, "# external change\n");
          return spawn(executable, args, options);
        } });
      await expect(conflictService.setEnabled("local", "project", { plugin: "review", marketplace: "team", enabled: true })).rejects.toThrow();
      expect(fs.readFileSync(configPath, "utf8")).toBe(`${saved}# external change\n`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
