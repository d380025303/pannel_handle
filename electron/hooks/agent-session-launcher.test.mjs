import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  AGENT_COMMANDS,
  buildAgentStartCommand,
  createAgentSessionLauncher
} = require("./agent-session-launcher.cjs");

function installed(provider) {
  return {
    ok: true,
    providers: { [provider]: { status: "installed" } }
  };
}

function createMocks(overrides = {}) {
  const sessions = [];
  const terminalManager = {
    createSession: vi.fn((options) => {
      const session = { ...options, id: "run-1", templateId: "1" };
      sessions.push(session);
      return session;
    }),
    launchSession: vi.fn((template, options) => {
      const session = { ...template, ...options, id: `run-${sessions.length + 1}`, templateId: template.id };
      sessions.push(session);
      return session;
    }),
    listSessions: vi.fn(() => sessions),
    write: vi.fn(),
    closeSession: vi.fn(),
    deleteSavedSession: vi.fn()
  };
  const hookConfigManager = {
    inspect: vi.fn((_target, [provider]) => installed(provider)),
    install: vi.fn((_target, [provider]) => installed(provider))
  };
  const remoteHookConfigService = {
    inspect: vi.fn((_target, [provider]) => Promise.resolve(installed(provider))),
    install: vi.fn((_target, [provider]) => Promise.resolve(installed(provider)))
  };
  const sshSessionRuntime = { exec: vi.fn(() => Promise.resolve("/usr/bin/agent")) };
  const sshHookTunnelService = { ensureTunnel: vi.fn(() => Promise.resolve({ hookUrl: "http://127.0.0.1:9000/opencode-hook" })) };
  const spawnSync = vi.fn(() => ({ status: 0, stdout: "found" }));
  const launcher = createAgentSessionLauncher({
    terminalManager,
    hookConfigManager,
    remoteHookConfigService,
    sshSessionRuntime,
    sshHookTunnelService,
    spawnSync,
    ...overrides
  });
  return { launcher, terminalManager, hookConfigManager, remoteHookConfigService, sshSessionRuntime, sshHookTunnelService, spawnSync };
}

describe("agent-session-launcher", () => {
  it("maps all supported providers to fixed CLI commands", () => {
    expect(AGENT_COMMANDS).toEqual({
      claude: "claude",
      codex: "codex",
      opencode: "opencode",
      qoder: "qoderclicn"
    });
  });

  it("builds environment-specific commands and only starts after a successful pre-command", () => {
    expect(buildAgentStartCommand({ type: "windows", agentProvider: "claude", initialCommand: "pnpm install" }))
      .toBe("& { pnpm install }; if ($?) { claude }");
    expect(buildAgentStartCommand({ type: "wsl", agentProvider: "codex", initialCommand: "pnpm install" }))
      .toBe("pnpm install && codex");
    expect(buildAgentStartCommand({ type: "ssh", agentProvider: "opencode" }, { hookUrl: "http://local/hook", sessionId: "run-2" }))
      .toContain("PANNEL_HANDLE_SESSION_ID='run-2' opencode");
  });

  it("checks and repairs a local hook before creating the terminal", async () => {
    const mocks = createMocks();
    mocks.hookConfigManager.inspect.mockReturnValue({ ok: true, providers: { claude: { status: "needs_repair" } } });

    await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "claude", initialCommand: "pnpm install" });

    expect(mocks.spawnSync).toHaveBeenCalledWith("where.exe", ["claude"], expect.any(Object));
    expect(mocks.hookConfigManager.install).toHaveBeenCalled();
    expect(mocks.terminalManager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      initialCommand: "pnpm install",
      runtimeInitialCommand: "& { pnpm install }; if ($?) { claude }"
    }));
  });

  it("does not create a local session when the CLI is missing", async () => {
    const mocks = createMocks();
    mocks.spawnSync.mockReturnValue({ status: 1 });

    await expect(mocks.launcher.createSession({ type: "wsl", wslDistro: "Ubuntu", cwd: "/work", agentProvider: "codex" }))
      .rejects.toThrow("codex");
    expect(mocks.terminalManager.createSession).not.toHaveBeenCalled();
  });

  it("installs SSH hooks, injects OpenCode tunnel environment, and starts the CLI", async () => {
    const mocks = createMocks();
    mocks.remoteHookConfigService.inspect.mockResolvedValue({ ok: true, providers: { opencode: { status: "not_installed" } } });

    await mocks.launcher.createSession({ type: "ssh", cwd: "/srv/app", agentProvider: "opencode", sshConfig: { host: "example.com" } });

    expect(mocks.sshSessionRuntime.exec).toHaveBeenCalled();
    expect(mocks.remoteHookConfigService.install).toHaveBeenCalled();
    expect(mocks.terminalManager.write).toHaveBeenCalledWith("run-1", expect.stringContaining("cd '/srv/app' && PANNEL_HANDLE_HOOK_URL="));
  });

  it("cleans up a failed new SSH session and its saved template", async () => {
    const mocks = createMocks();
    mocks.sshSessionRuntime.exec.mockRejectedValue(new Error("not found"));

    await expect(mocks.launcher.createSession({ type: "ssh", cwd: "/srv/app", agentProvider: "qoder", sshConfig: { host: "example.com" } }))
      .rejects.toThrow("未在远程 SSH 环境中找到命令：qoderclicn");
    expect(mocks.terminalManager.closeSession).toHaveBeenCalledWith("run-1");
    expect(mocks.terminalManager.deleteSavedSession).toHaveBeenCalledWith("1");
  });

  it("stops a batch after failure while preserving earlier successful launches", async () => {
    const mocks = createMocks();
    mocks.spawnSync.mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 1 });

    await expect(mocks.launcher.launchSessions([
      { id: "1", type: "windows", cwd: "C:\\one", agentProvider: "claude" },
      { id: "2", type: "windows", cwd: "C:\\two", agentProvider: "codex" }
    ])).rejects.toThrow("codex");
    expect(mocks.terminalManager.launchSession).toHaveBeenCalledTimes(1);
  });
});
