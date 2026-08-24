import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  AGENT_COMMANDS,
  buildAgentStartCommand,
  buildOpenRouterCodexCommand,
  createAgentSessionLauncher,
  wrapAgentStartCommand
} = require("./agent-session-launcher.cjs");

const AGENT_EXIT_MARKER = "__PANNEL_HANDLE_AGENT_EXIT__";

function installed(provider) {
  return {
    ok: true,
    providers: { [provider]: { status: "installed" } }
  };
}

function createMocks(overrides = {}) {
  const sessions = [];
  let nextRuntimeId = 1;
  const onTemplateLaunched = vi.fn();
  const terminalManager = {
    createSession: vi.fn((options) => {
      const session = { ...options, id: `run-${nextRuntimeId++}`, templateId: "1" };
      sessions.push(session);
      return session;
    }),
    launchSession: vi.fn((template, options) => {
      const templateId = Object.prototype.hasOwnProperty.call(options, "templateId")
        ? options.templateId
        : template.id;
      const session = { ...template, id: `run-${nextRuntimeId++}`, templateId };
      sessions.push(session);
      return session;
    }),
    startDeferredSession: vi.fn((id, options) => ({ id, type: "ssh", agentProvider: "codex", agentLocation: "local", ...options })),
    listSessions: vi.fn(() => sessions),
    getSession: vi.fn((id) => sessions.find((session) => session.id === id)),
    write: vi.fn(),
    closeSession: vi.fn((id) => {
      const index = sessions.findIndex(session => session.id === id);
      if (index >= 0) sessions.splice(index, 1);
      return sessions;
    }),
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
  const openRouterService = { getApiKey: vi.fn(() => "sk-or-secret") };
  const launcher = createAgentSessionLauncher({
    terminalManager,
    hookConfigManager,
    remoteHookConfigService,
    sshSessionRuntime,
    sshHookTunnelService,
    onTemplateLaunched,
    spawnSync,
    getDefaultShell,
    openRouterService,
    ...overrides
  });
  return { launcher, terminalManager, hookConfigManager, remoteHookConfigService, sshSessionRuntime, sshHookTunnelService, onTemplateLaunched, spawnSync, getDefaultShell, sessions };
}

describe("agent-session-launcher", () => {
  it("maps all supported providers to fixed CLI commands", () => {
    expect(AGENT_COMMANDS).toEqual({
      claude: "claude",
      codex: "codex",
      codebuddy: "codebuddy",
      opencode: "opencode",
      qoder: "qoder",
      copilot: "copilot",
      gemini: "gemini"
    });
  });

  it("requires Gemini CLI 0.26.0 or newer on Windows", async () => {
    const old = createMocks({
      spawnSync: vi.fn((command) => command === "where.exe"
        ? { status: 0, stdout: "gemini.cmd" }
        : { status: 0, stdout: "0.25.9" })
    });
    await expect(old.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "gemini" }))
      .rejects.toThrow("最低 0.26.0");

    const current = createMocks({
      spawnSync: vi.fn((command) => command === "where.exe"
        ? { status: 0, stdout: "gemini.cmd" }
        : { status: 0, stdout: "0.56.0" })
    });
    await expect(current.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "gemini" })).resolves.toMatchObject({ agentProvider: "gemini" });
  });

  it("rejects Windows Gemini shims and SSH Gemini sessions", async () => {
    const wsl = createMocks({
      spawnSync: vi.fn((command, args) => command === "wsl.exe" && String(args.at(-1)).includes("resolved=")
        ? { status: 126, stderr: "WINDOWS_SHIM" }
        : { status: 0, stdout: "/mnt/c/Users/me/gemini" })
    });
    await expect(wsl.launcher.createSession({ type: "wsl", wslDistro: "Ubuntu", cwd: "/work", agentProvider: "gemini" }))
      .rejects.toThrow("原生 Gemini CLI");
    await expect(wsl.launcher.createSession({ type: "ssh", cwd: "/work", agentProvider: "gemini" }))
      .rejects.toThrow("仅支持 Windows 和 WSL");
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

  it("builds Responses-only OpenRouter overrides without embedding the API key", () => {
    const command = buildOpenRouterCodexCommand("openai/gpt-5.4");
    expect(command).toContain("model_provider='openrouter'");
    expect(command).toContain("wire_api='responses'");
    expect(command).toContain("https://openrouter.ai/api/v1");
    expect(command).not.toContain("sk-or-");
    expect(() => buildOpenRouterCodexCommand("bad model & calc")).toThrow("有效的 OpenRouter 模型");
  });

  it("injects the OpenRouter key only through the local process environment", async () => {
    const mocks = createMocks();
    await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codex", codexBackend: "openrouter", codexModel: "openai/gpt-5.4" });

    expect(mocks.terminalManager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      runtimeEnv: { OPENROUTER_API_KEY: "sk-or-secret" },
      runtimeInitialCommand: expect.stringContaining("model_provider='openrouter'")
    }));
    expect(mocks.terminalManager.createSession.mock.calls[0][0].runtimeInitialCommand).not.toContain("sk-or-secret");
  });

  it("rejects OpenRouter for a Codex process running on the remote SSH host", async () => {
    const mocks = createMocks();
    await expect(mocks.launcher.createSession({
      type: "ssh",
      cwd: "/srv/app",
      agentProvider: "codex",
      agentLocation: "remote",
      codexBackend: "openrouter",
      codexModel: "openai/gpt-5.4",
      sshConfig: { host: "example.com" }
    })).rejects.toThrow("远程 SSH Codex 暂不支持 OpenRouter");
    expect(mocks.terminalManager.createSession).not.toHaveBeenCalled();
  });

  it("keeps the OpenRouter key local when Codex uses the SSH bridge", async () => {
    const remoteAgentBridgeService = {
      createBinding: vi.fn(async () => ({
        workspacePath: "C:\\runtime\\run-1",
        url: "http://127.0.0.1:4568/mcp",
        token: "bridge-token",
        tokenEnv: "PANNEL_HANDLE_REMOTE_AGENT_TOKEN"
      })),
      runConfiguredCommand: vi.fn(),
      closeBinding: vi.fn()
    };
    const mocks = createMocks({ remoteAgentBridgeService });

    await mocks.launcher.createSession({
      type: "ssh",
      cwd: "/srv/app",
      agentProvider: "codex",
      agentLocation: "local",
      codexBackend: "openrouter",
      codexModel: "openai/gpt-5.4",
      sshConfig: { host: "example.com" }
    });

    expect(mocks.sshSessionRuntime.exec).not.toHaveBeenCalled();
    expect(mocks.terminalManager.startDeferredSession).toHaveBeenCalledWith("run-1", expect.objectContaining({
      runtimeEnv: {
        PANNEL_HANDLE_REMOTE_AGENT_TOKEN: "bridge-token",
        OPENROUTER_API_KEY: "sk-or-secret"
      },
      runtimeInitialCommand: expect.stringContaining("model_provider='openrouter'")
    }));
    expect(mocks.terminalManager.startDeferredSession.mock.calls[0][1].runtimeInitialCommand).not.toContain("sk-or-secret");
  });

  it("starts CodeBuddy with its canonical command", () => {
    expect(buildAgentStartCommand({ type: "windows", shell: "cmd.exe", agentProvider: "codebuddy" }))
      .toBe("codebuddy");
  });

  it.each([
    [{ type: "windows", shell: "powershell.exe" }, "Write-Output"],
    [{ type: "windows", shell: "cmd.exe" }, "echo"],
    [{ type: "wsl" }, "printf"]
  ])("wraps Agent exit output for %# without embedding the complete marker", (session, outputCommand) => {
    const command = wrapAgentStartCommand(session, "codex");

    expect(command).toContain(outputCommand);
    expect(command).not.toContain(AGENT_EXIT_MARKER);
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
      runtimeInitialCommand: expect.stringContaining("pnpm install && claude & echo. & echo __PANNEL_HANDLE_AGENT^_EXIT__")
    }));
  });

  it("defaults a Windows Agent session to the current user directory", async () => {
    const getHomeDirectory = vi.fn(() => "C:\\Users\\tester");
    const mocks = createMocks({ getHomeDirectory });

    await mocks.launcher.createSession({ type: "windows", agentProvider: "codex", persist: false });

    expect(getHomeDirectory).toHaveBeenCalledTimes(1);
    expect(mocks.hookConfigManager.inspect).toHaveBeenCalledWith(
      { type: "windows", path: "C:\\Users\\tester" },
      ["codex"]
    );
    expect(mocks.terminalManager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "C:\\Users\\tester",
      agentProvider: "codex",
      persist: false,
      runtimeInitialCommand: expect.stringContaining("codex & echo. & echo __PANNEL_HANDLE_AGENT^_EXIT__")
    }));
  });

  it("forwards transient creation to the terminal manager", async () => {
    const mocks = createMocks();

    await mocks.launcher.createSession({
      type: "windows",
      cwd: "C:\\work",
      agentProvider: "codex",
      persist: false
    });

    expect(mocks.terminalManager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agentProvider: "codex",
      persist: false,
      runtimeInitialCommand: expect.stringContaining("codex & echo. & echo __PANNEL_HANDLE_AGENT^_EXIT__")
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

  it("starts GitHub Copilot on Windows after checking Copilot and pwsh", async () => {
    const mocks = createMocks();

    await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "copilot" });

    expect(mocks.spawnSync).toHaveBeenNthCalledWith(1, "where.exe", ["copilot"], expect.any(Object));
    expect(mocks.spawnSync).toHaveBeenNthCalledWith(2, "where.exe", ["pwsh"], expect.any(Object));
    expect(mocks.terminalManager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agentProvider: "copilot",
      runtimeInitialCommand: expect.stringContaining("copilot")
    }));
  });

  it("rejects GitHub Copilot when pwsh is unavailable on Windows", async () => {
    const mocks = createMocks();
    mocks.spawnSync
      .mockReturnValueOnce({ status: 0, stdout: "copilot" })
      .mockReturnValueOnce({ status: 1, stdout: "" });

    await expect(mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "copilot" }))
      .rejects.toThrow("PowerShell 6");
    expect(mocks.terminalManager.createSession).not.toHaveBeenCalled();
  });

  it("rejects GitHub Copilot SSH sessions before creating a terminal", async () => {
    const mocks = createMocks();

    await expect(mocks.launcher.createSession({ type: "ssh", cwd: "/srv/app", agentProvider: "copilot", sshConfig: { host: "example.com" } }))
      .rejects.toThrow("GitHub Copilot CLI 首期仅支持 Windows 和 WSL 会话");
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
    expect(mocks.terminalManager.write).toHaveBeenCalledWith("run-1", expect.stringContaining("cd '/srv/app' && codex;"));
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
    expect(mocks.terminalManager.write).toHaveBeenCalledWith("run-1", expect.stringContaining("cd '/srv/app' && codex;"));
  });

  it("runs Codex locally and binds it to an SSH workspace without checking a remote CLI", async () => {
    const remoteAgentBridgeService = {
      createBinding: vi.fn(async () => ({
        workspacePath: "C:\\runtime\\run-1",
        developerInstructions: "Use the remote workspace's scoped tools.\nDo not edit local files.",
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
      runtimeShell: "powershell.exe",
      runtimeEnv: { PANNEL_HANDLE_REMOTE_AGENT_TOKEN: "secret-token" },
      runtimeInitialCommand: expect.stringMatching(/mcp_servers\.pannel_handle_remote\.url.*developer_instructions/)
    }));
    expect(mocks.hookConfigManager.inspect).toHaveBeenCalledWith(
      { type: "windows", path: "C:\\runtime\\run-1" },
      ["codex"]
    );
  });

  it("cleans up a failed new SSH session and its saved template", async () => {
    const mocks = createMocks();
    mocks.sshSessionRuntime.exec.mockRejectedValue(new Error("not found"));

    await expect(mocks.launcher.createSession({ type: "ssh", cwd: "/srv/app", agentProvider: "qoder", sshConfig: { host: "example.com" } }))
      .rejects.toThrow("未在远程 SSH 环境中找到命令：qoder");
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

  it("validates the target, closes the old terminal, and launches a runtime-only replacement", async () => {
    const mocks = createMocks();
    await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codex", persist: true });
    mocks.terminalManager.createSession.mockClear();

    const result = await mocks.launcher.switchAgent("run-1", "claude");

    expect(mocks.hookConfigManager.inspect).toHaveBeenLastCalledWith({ type: "windows", path: "C:\\work" }, ["claude"]);
    expect(mocks.terminalManager.closeSession).toHaveBeenCalledWith("run-1");
    expect(mocks.terminalManager.launchSession).toHaveBeenCalledWith(expect.objectContaining({
      id: "1",
      cwd: "C:\\work",
      agentProvider: "claude"
    }), expect.objectContaining({
      useProvidedTemplate: true,
      templateId: "1",
      runtimeInitialCommand: expect.stringContaining("claude & echo. & echo __PANNEL_HANDLE_AGENT^_EXIT__")
    }));
    expect(mocks.terminalManager.closeSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.terminalManager.launchSession.mock.invocationCallOrder[0]);
    expect(mocks.terminalManager.createSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: "run-2", templateId: "1", agentProvider: "claude" });
    expect(mocks.sessions).toEqual([expect.objectContaining({ id: "run-2", agentProvider: "claude" })]);
  });

  it("keeps the old terminal open when target validation fails", async () => {
    const mocks = createMocks();
    await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codex", persist: true });
    mocks.spawnSync.mockReturnValueOnce({ status: 1, stdout: "" });

    await expect(mocks.launcher.switchAgent("run-1", "claude")).rejects.toThrow();

    expect(mocks.terminalManager.closeSession).not.toHaveBeenCalled();
    expect(mocks.terminalManager.launchSession).not.toHaveBeenCalled();
    expect(mocks.sessions).toEqual([expect.objectContaining({ id: "run-1", agentProvider: "codex" })]);
  });

  it("rebuilds remote SSH setup with the replacement runtime id", async () => {
    const mocks = createMocks();
    await mocks.launcher.createSession({
      type: "ssh",
      cwd: "/srv/app",
      agentProvider: "codex",
      agentLocation: "remote",
      sshConfig: { host: "example.com" },
      persist: true
    });
    mocks.sshSessionRuntime.exec.mockClear();
    mocks.terminalManager.write.mockClear();

    const result = await mocks.launcher.switchAgent("run-1", "claude");

    expect(mocks.terminalManager.closeSession).toHaveBeenCalledWith("run-1");
    expect(mocks.sshSessionRuntime.exec).toHaveBeenCalledWith(
      "run-2",
      expect.stringContaining("command -v"),
      expect.any(Object)
    );
    expect(mocks.terminalManager.write).toHaveBeenCalledWith(
      "run-2",
      expect.stringContaining("cd '/srv/app' && claude")
    );
    expect(result).toMatchObject({ id: "run-2", templateId: "1", agentProvider: "claude" });
  });

  it("does not allow a local SSH bridge session to change provider", async () => {
    const mocks = createMocks();
    mocks.terminalManager.getSession.mockReturnValue({
      id: "run-1",
      type: "ssh",
      cwd: "/srv/app",
      agentProvider: "codex",
      agentLocation: "local"
    });

    await expect(mocks.launcher.switchAgent("run-1", "claude")).rejects.toThrow("Local SSH bridge");
    expect(mocks.terminalManager.closeSession).not.toHaveBeenCalled();
    expect(mocks.terminalManager.launchSession).not.toHaveBeenCalled();
  });
});
