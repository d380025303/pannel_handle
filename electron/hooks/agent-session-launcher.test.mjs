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
  const onTemplateLaunched = vi.fn();
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
    startDeferredSession: vi.fn((id, options) => ({ id, type: "ssh", agentProvider: "codex", agentLocation: "local", ...options })),
    listSessions: vi.fn(() => sessions),
    write: vi.fn(),
    closeSession: vi.fn(),
    deleteSavedSession: vi.fn(),
    broadcastAgentHookDebug: vi.fn()
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
  const getDefaultShell = vi.fn(() => "C:\\Windows\\System32\\cmd.exe");
  const launcher = createAgentSessionLauncher({
    terminalManager,
    hookConfigManager,
    remoteHookConfigService,
    sshSessionRuntime,
    sshHookTunnelService,
    onTemplateLaunched,
    spawnSync,
    getDefaultShell,
    ...overrides
  });
  return { launcher, terminalManager, hookConfigManager, remoteHookConfigService, sshSessionRuntime, sshHookTunnelService, onTemplateLaunched, spawnSync, getDefaultShell };
}

describe("agent-session-launcher", () => {
  it("maps all supported providers to fixed CLI commands", () => {
    expect(AGENT_COMMANDS).toEqual({
      claude: "claude",
      codex: "codex",
      codebuddy: "codebuddy",
      opencode: "opencode",
      qoder: "qoderclicn"
    });
  });

  it("uses cmd syntax for a Windows Agent pre-command", () => {
    const command = buildAgentStartCommand({
      type: "windows",
      shell: "C:\\Windows\\System32\\cmd.exe",
      agentProvider: "codex",
      initialCommand: "chcp 65001 && set HTTP_PROXY=http://127.0.0.1:7892 && set HTTPS_PROXY=http://127.0.0.1:7892"
    });

    expect(command).toBe("chcp 65001 && set HTTP_PROXY=http://127.0.0.1:7892 && set HTTPS_PROXY=http://127.0.0.1:7892 && codex");
    expect(command).not.toContain("& {");
    expect(command).not.toContain("if ($?)");
  });

  it("preserves PowerShell syntax for an explicit PowerShell session", () => {
    expect(buildAgentStartCommand({ type: "windows", shell: "pwsh.exe", agentProvider: "claude", initialCommand: "pnpm install" }))
      .toBe("& { pnpm install }; if ($?) { claude }");
  });

  it("builds POSIX Agent commands for WSL and SSH", () => {
    expect(buildAgentStartCommand({ type: "wsl", agentProvider: "codex", initialCommand: "pnpm install" }))
      .toBe("pnpm install && codex");
    expect(buildAgentStartCommand({ type: "ssh", agentProvider: "opencode" }, { hookUrl: "http://local/hook", sessionId: "run-2" }))
      .toContain("PANNEL_HANDLE_SESSION_ID='run-2' opencode");
  });

  it("starts the Agent directly when there is no pre-command", () => {
    expect(buildAgentStartCommand({ type: "windows", shell: "cmd.exe", agentProvider: "codex" }))
      .toBe("codex");
  });

  it("starts CodeBuddy with its canonical command", () => {
    expect(buildAgentStartCommand({ type: "windows", shell: "cmd.exe", agentProvider: "codebuddy" }))
      .toBe("codebuddy");
  });

  it("checks and repairs a local hook before creating the terminal", async () => {
    const mocks = createMocks();
    mocks.hookConfigManager.inspect.mockReturnValue({ ok: true, providers: { claude: { status: "needs_repair" } } });

    await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "claude", initialCommand: "pnpm install" });

    expect(mocks.spawnSync).toHaveBeenCalledWith("where.exe", ["claude"], expect.any(Object));
    expect(mocks.hookConfigManager.install).toHaveBeenCalled();
    expect(mocks.terminalManager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      shell: "C:\\Windows\\System32\\cmd.exe",
      initialCommand: "pnpm install",
      runtimeInitialCommand: "pnpm install && claude"
    }));
  });

  it("does not create a local session when the CLI is missing", async () => {
    const mocks = createMocks();
    mocks.spawnSync.mockReturnValue({ status: 1 });

    await expect(mocks.launcher.createSession({ type: "wsl", wslDistro: "Ubuntu", cwd: "/work", agentProvider: "codex" }))
      .rejects.toThrow("codex");
    expect(mocks.terminalManager.createSession).not.toHaveBeenCalled();
  });

  it("shows the official install command when CodeBuddy is missing", async () => {
    const mocks = createMocks();
    mocks.spawnSync.mockReturnValue({ status: 1 });

    await expect(mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codebuddy" }))
      .rejects.toThrow("npm install -g @tencent-ai/codebuddy-code");
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

  it("continues launching Codex over SSH when optional remote hook setup fails", async () => {
    const mocks = createMocks();
    mocks.remoteHookConfigService.inspect.mockResolvedValue({
      ok: false,
      error: "Connection lost before handshake",
      providers: {}
    });

    await mocks.launcher.createSession({ type: "ssh", cwd: "/srv/app", agentProvider: "codex", sshConfig: { host: "example.com" } });

    expect(mocks.remoteHookConfigService.install).not.toHaveBeenCalled();
    expect(mocks.terminalManager.closeSession).not.toHaveBeenCalled();
    expect(mocks.terminalManager.deleteSavedSession).not.toHaveBeenCalled();
    expect(mocks.terminalManager.broadcastAgentHookDebug).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      eventName: "SshHookSetupFailed",
      matchedSessionId: "run-1",
      handled: false
    }));
    expect(mocks.terminalManager.write).toHaveBeenCalledWith(
      "run-1",
      expect.stringContaining("Remote codex notification Hook is unavailable:")
    );
    expect(mocks.terminalManager.write).toHaveBeenCalledWith(
      "run-1",
      expect.stringContaining("Connection lost before handshake")
    );
    expect(mocks.terminalManager.write).toHaveBeenCalledWith("run-1", expect.stringContaining("cd '/srv/app' && codex\r"));
  });

  it("continues launching Codex over SSH when the auxiliary command check fails", async () => {
    const mocks = createMocks();
    mocks.sshSessionRuntime.exec.mockRejectedValue(new Error("command check closed before it was ready"));

    await mocks.launcher.createSession({ type: "ssh", cwd: "/srv/app", agentProvider: "codex", sshConfig: { host: "example.com" } });

    expect(mocks.terminalManager.closeSession).not.toHaveBeenCalled();
    expect(mocks.terminalManager.deleteSavedSession).not.toHaveBeenCalled();
    expect(mocks.terminalManager.broadcastAgentHookDebug).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      eventName: "SshCommandCheckFailed",
      matchedSessionId: "run-1",
      handled: false
    }));
    expect(mocks.terminalManager.write).toHaveBeenCalledWith(
      "run-1",
      expect.stringContaining("Remote codex command check failed:")
    );
    expect(mocks.terminalManager.write).toHaveBeenCalledWith("run-1", expect.stringContaining("cd '/srv/app' && codex\r"));
  });

  it("runs Codex locally and binds it to an SSH workspace without checking a remote CLI", async () => {
    const remoteAgentBridgeService = {
      createBinding: vi.fn(async () => ({
        workspacePath: "C:\\runtime\\run-1",
        url: "http://127.0.0.1:4568/mcp",
        token: "secret-token",
        tokenEnv: "PANNEL_HANDLE_REMOTE_AGENT_TOKEN"
      })),
      runConfiguredCommand: vi.fn(async () => ({ exitCode: 0 })),
      closeBinding: vi.fn(async () => {})
    };
    const mocks = createMocks({ remoteAgentBridgeService });

    await mocks.launcher.createSession({
      type: "ssh",
      cwd: "/srv/app",
      initialCommand: "git status --short",
      agentProvider: "codex",
      agentLocation: "local",
      sshConfig: { host: "example.com" }
    });

    expect(mocks.terminalManager.createSession).toHaveBeenCalledWith(expect.objectContaining({ deferTerminalStart: true }));
    expect(mocks.sshSessionRuntime.exec).not.toHaveBeenCalled();
    expect(mocks.remoteHookConfigService.inspect).not.toHaveBeenCalled();
    expect(remoteAgentBridgeService.createBinding).toHaveBeenCalledWith("run-1");
    expect(remoteAgentBridgeService.runConfiguredCommand).toHaveBeenCalledWith("run-1", "git status --short");
    expect(mocks.terminalManager.startDeferredSession).toHaveBeenCalledWith("run-1", expect.objectContaining({
      terminalTransport: "local-agent",
      runtimeCwd: "C:\\runtime\\run-1",
      runtimeEnv: { PANNEL_HANDLE_REMOTE_AGENT_TOKEN: "secret-token" },
      runtimeInitialCommand: expect.stringContaining("mcp_servers.pannel_handle_remote.url")
    }));
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
    ], { recordUsage: true })).rejects.toThrow("codex");
    expect(mocks.terminalManager.launchSession).toHaveBeenCalledTimes(1);
    expect(mocks.onTemplateLaunched).toHaveBeenCalledTimes(1);
    expect(mocks.onTemplateLaunched).toHaveBeenCalledWith("1");
  });

  it("records only explicitly tracked successful template launches", async () => {
    const mocks = createMocks();
    const template = { id: "template-1", type: "windows", cwd: "C:\\work" };

    await mocks.launcher.launchSession(template);
    expect(mocks.onTemplateLaunched).not.toHaveBeenCalled();

    await mocks.launcher.launchSession(template, { recordUsage: true });
    expect(mocks.onTemplateLaunched).toHaveBeenCalledTimes(1);
    expect(mocks.onTemplateLaunched).toHaveBeenCalledWith("template-1");
    expect(mocks.terminalManager.launchSession).toHaveBeenLastCalledWith(template, {});
  });

  it("does not record a failed tracked launch", async () => {
    const mocks = createMocks();
    mocks.terminalManager.launchSession.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });

    await expect(mocks.launcher.launchSession(
      { id: "template-1", type: "windows", cwd: "C:\\work" },
      { recordUsage: true }
    )).rejects.toThrow("spawn failed");
    expect(mocks.onTemplateLaunched).not.toHaveBeenCalled();
  });
});
