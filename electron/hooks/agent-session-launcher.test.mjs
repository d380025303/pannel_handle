import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  AGENT_COMMANDS,
  buildAgentStartCommand,
  buildLocalCodeBuddyConfig,
  buildLocalCodeBuddyStartCommand,
  buildLocalOpenCodeConfig,
  buildLocalOpenCodeStartCommand,
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
    startDeferredSession: vi.fn((id, options) => {
      const session = sessions.find((entry) => entry.id === id);
      if (!session) throw new Error("missing deferred session");
      Object.assign(session, options);
      return session;
    }),
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
  const spawnSync = vi.fn((command, args) => {
    const invocation = `${command} ${(args || []).join(" ")}`;
    if (invocation.includes("codebuddy --version")) return { status: 0, stdout: "2.137.1" };
    if (invocation.includes("gemini --version")) return { status: 0, stdout: "0.56.0" };
    if (invocation.includes("grok --version")) return { status: 0, stdout: "grok 0.2.106" };
    return { status: 0, stdout: "found" };
  });
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
      gemini: "gemini",
      grok: "grok"
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

  it("requires official Grok CLI 0.2.106 or newer and rejects SSH", async () => {
    const old = createMocks({
      spawnSync: vi.fn((command) => command === "where.exe"
        ? { status: 0, stdout: "grok.exe" }
        : { status: 0, stdout: "grok 0.2.105" })
    });
    await expect(old.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "grok" }))
      .rejects.toThrow("最低 0.2.106");

    const current = createMocks();
    await expect(current.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "grok" }))
      .resolves.toMatchObject({ agentProvider: "grok" });
    await expect(current.launcher.createSession({ type: "ssh", cwd: "/work", agentProvider: "grok" }))
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

  it("requires CodeBuddy CLI 2.54.0 or newer only for the local bridge", async () => {
    const old = createMocks({
      spawnSync: vi.fn((command, args) => `${command} ${(args || []).join(" ")}`.includes("--version")
        ? { status: 0, stdout: "2.53.9" }
        : { status: 0, stdout: "codebuddy.cmd" })
    });
    await expect(old.launcher.createSession({
      type: "ssh",
      cwd: "/srv/app",
      agentProvider: "codebuddy",
      agentLocation: "local",
      sshConfig: { host: "example.com" }
    })).rejects.toThrow("本地桥接最低 2.54.0");

    await expect(old.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codebuddy" }))
      .resolves.toMatchObject({ agentProvider: "codebuddy" });
  });

  it("builds an OpenRouter Codex command without embedding the API key", () => {
    const command = buildOpenRouterCodexCommand({ type: "windows", shell: "powershell.exe" }, {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      apiKey: "secret-value",
      catalogPath: "C:\\Data\\openrouter-models.json",
      model: "anthropic/claude-sonnet-4"
    });

    expect(command).toContain("model_provider");
    expect(command).toContain("wire_api");
    expect(command).toContain("anthropic/claude-sonnet-4");
    expect(command).not.toContain("secret-value");
  });

  it("builds an authenticated OpenCode bridge config without embedding the token", () => {
    const binding = {
      workspacePath: "C:\\runtime\\run-1",
      developerInstructions: "Use only the remote workspace tools.",
      url: "http://127.0.0.1:4568/mcp",
      token: "secret-token",
      tokenEnv: "PANNEL_HANDLE_REMOTE_AGENT_TOKEN"
    };

    const configText = buildLocalOpenCodeConfig(binding);
    const config = JSON.parse(configText);

    expect(config.mcp.pannel_handle_remote).toEqual(expect.objectContaining({
      type: "remote",
      url: binding.url,
      enabled: true,
      oauth: false,
      headers: { Authorization: "Bearer {env:PANNEL_HANDLE_REMOTE_AGENT_TOKEN}" }
    }));
    expect(config.agent["pannel-handle-remote"]).toEqual(expect.objectContaining({
      mode: "primary",
      prompt: binding.developerInstructions,
      permission: expect.objectContaining({ edit: "deny", bash: "deny", task: "deny", "pannel_handle_remote_*": "allow" })
    }));
    expect(configText).not.toContain(binding.token);
    expect(buildLocalOpenCodeStartCommand(binding)).toBe("opencode 'C:\\runtime\\run-1' --agent pannel-handle-remote");
  });

  it("builds a strict CodeBuddy bridge config with an environment token placeholder", () => {
    const binding = {
      runtimeInstructions: "Use the remote workspace's scoped tools.\nDo not edit local files or run `Bash`.",
      url: "http://127.0.0.1:4568/mcp",
      token: "secret-token",
      tokenEnv: "PANNEL_HANDLE_REMOTE_AGENT_TOKEN"
    };
    const config = JSON.parse(buildLocalCodeBuddyConfig(binding));
    const command = buildLocalCodeBuddyStartCommand(binding);

    expect(config.mcpServers.pannel_handle_remote).toEqual({
      type: "http",
      url: binding.url,
      headers: { Authorization: "Bearer ${PANNEL_HANDLE_REMOTE_AGENT_TOKEN}" }
    });
    expect(command).toContain("--strict-mcp-config");
    expect(command).toContain("--tools 'Read,Glob,Grep'");
    expect(command).toContain('--append-system-prompt "$env:PANNEL_HANDLE_REMOTE_AGENT_INSTRUCTIONS"');
    expect(command).not.toMatch(/[\r\n]/);
    expect(command).not.toContain(binding.runtimeInstructions);
    expect(command).not.toContain("secret-token");
  });

  it("injects the OpenRouter key only through the terminal environment", async () => {
    const openRouterService = { getLaunchConfig: vi.fn(() => ({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      apiKey: "secret-value",
      catalogPath: "C:\\Data\\openrouter-models.json",
      model: "openai/gpt-5.4"
    })) };
    const mocks = createMocks({ openRouterService });

    await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codex", codexBackend: "openrouter", codexModel: "openai/gpt-5.4" });

    expect(mocks.terminalManager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      runtimeEnv: { OPENROUTER_API_KEY: "secret-value" },
      runtimeWslEnvKeys: ["OPENROUTER_API_KEY"],
      runtimeInitialCommand: expect.not.stringContaining("secret-value")
    }));
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

  it("runs OpenCode locally with inline bridge configuration and its notification plugin", async () => {
    const remoteAgentBridgeService = {
      createBinding: vi.fn(async () => ({
        workspacePath: "C:\\runtime\\run-1",
        developerInstructions: "Use only the scoped remote tools.",
        url: "http://127.0.0.1:4568/mcp",
        token: "secret-token",
        tokenEnv: "PANNEL_HANDLE_REMOTE_AGENT_TOKEN"
      })),
      runConfiguredCommand: vi.fn(async () => ({ exitCode: 0 })),
      closeBinding: vi.fn(async () => {})
    };
    const mocks = createMocks({ remoteAgentBridgeService });

    const result = await mocks.launcher.createSession({
      type: "ssh",
      cwd: "/srv/app",
      agentProvider: "opencode",
      agentLocation: "local",
      sshConfig: { host: "example.com" }
    });

    expect(result).toMatchObject({ agentProvider: "opencode", terminalTransport: "local-agent" });
    expect(mocks.sshSessionRuntime.exec).not.toHaveBeenCalled();
    expect(mocks.hookConfigManager.inspect).toHaveBeenCalledWith(
      { type: "windows", path: "C:\\runtime\\run-1" },
      ["opencode"]
    );
    const runtime = mocks.terminalManager.startDeferredSession.mock.calls[0][1];
    expect(runtime.runtimeEnv.PANNEL_HANDLE_REMOTE_AGENT_TOKEN).toBe("secret-token");
    expect(runtime.runtimeInitialCommand).toContain("opencode 'C:\\runtime\\run-1' --agent pannel-handle-remote");
    expect(runtime.runtimeInitialCommand).not.toContain("secret-token");
    expect(JSON.parse(runtime.runtimeEnv.OPENCODE_CONFIG_CONTENT).mcp.pannel_handle_remote.url)
      .toBe("http://127.0.0.1:4568/mcp");
  });

  it("runs CodeBuddy locally with a strict authenticated bridge and local hooks", async () => {
    const remoteAgentBridgeService = {
      createBinding: vi.fn(async () => ({
        workspacePath: "C:\\runtime\\run-1",
        runtimeInstructions: "Use the remote workspace's scoped tools.\nDo not edit local files or run `Bash`.",
        url: "http://127.0.0.1:4568/mcp",
        token: "secret-token",
        tokenEnv: "PANNEL_HANDLE_REMOTE_AGENT_TOKEN"
      })),
      runConfiguredCommand: vi.fn(async () => ({ exitCode: 0 })),
      closeBinding: vi.fn(async () => {})
    };
    const mocks = createMocks({ remoteAgentBridgeService });

    const result = await mocks.launcher.createSession({
      type: "ssh",
      cwd: "/srv/app",
      agentProvider: "codebuddy",
      agentLocation: "local",
      sshConfig: { host: "example.com" }
    });

    expect(result).toMatchObject({ agentProvider: "codebuddy", terminalTransport: "local-agent" });
    expect(mocks.hookConfigManager.inspect).toHaveBeenCalledWith(
      { type: "windows", path: "C:\\runtime\\run-1" },
      ["codebuddy"]
    );
    const runtime = mocks.terminalManager.startDeferredSession.mock.calls[0][1];
    expect(runtime.runtimeEnv).toEqual({
      PANNEL_HANDLE_REMOTE_AGENT_TOKEN: "secret-token",
      PANNEL_HANDLE_REMOTE_AGENT_INSTRUCTIONS: "Use the remote workspace's scoped tools.\nDo not edit local files or run `Bash`."
    });
    expect(runtime.runtimeInitialCommand).toContain("codebuddy --mcp-config");
    expect(runtime.runtimeInitialCommand).toContain("Bearer ${PANNEL_HANDLE_REMOTE_AGENT_TOKEN}");
    expect(runtime.runtimeInitialCommand).toContain('"$env:PANNEL_HANDLE_REMOTE_AGENT_INSTRUCTIONS"');
    expect(runtime.runtimeInitialCommand).not.toMatch(/[\r\n]/);
    expect(runtime.runtimeInitialCommand).not.toContain("Do not edit local files");
    expect(runtime.runtimeInitialCommand).not.toContain("secret-token");
  });

  it("allows a local Codex bridge to target a remote Windows workspace", async () => {
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

    await expect(mocks.launcher.createSession({
      type: "ssh",
      cwd: "C:\\Work Space\\repo",
      agentProvider: "codex",
      agentLocation: "local",
      sshConfig: { host: "windows.example.com", remotePlatform: "windows" }
    })).resolves.toMatchObject({ terminalTransport: "local-agent" });

    expect(remoteAgentBridgeService.createBinding).toHaveBeenCalledWith("run-1");
    expect(mocks.sshSessionRuntime.exec).not.toHaveBeenCalled();
  });

  it("keeps Windows workspace paths unavailable to WSL and remotely running SSH Agents", async () => {
    const mocks = createMocks();

    await expect(mocks.launcher.createSession({
      type: "wsl",
      wslDistro: "Ubuntu",
      cwd: "C:\\repo",
      agentProvider: "codex"
    })).rejects.toThrow("绝对 Linux 路径");

    await expect(mocks.launcher.createSession({
      type: "ssh",
      cwd: "C:\\repo",
      agentProvider: "codex",
      agentLocation: "remote",
      sshConfig: { host: "windows.example.com", remotePlatform: "windows" }
    })).rejects.toThrow("绝对 Linux 路径");

    expect(mocks.terminalManager.createSession).not.toHaveBeenCalled();
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

  it("rejects unsupported providers without closing a local SSH bridge session", async () => {
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

  it.each([
    ["codex", "opencode"],
    ["opencode", "codex"],
    ["codex", "codebuddy"],
    ["codebuddy", "opencode"],
    ["opencode", "codebuddy"]
  ])("switches a local SSH bridge from %s to %s with a new binding", async (currentProvider, targetProvider) => {
    const remoteAgentBridgeService = {
      createBinding: vi.fn(async (sessionId) => ({
        workspacePath: `C:\\runtime\\${sessionId}`,
        developerInstructions: "Use the remote workspace.",
        runtimeInstructions: "Use the remote workspace.\nUse only remote tools.",
        url: "http://127.0.0.1:4568/mcp",
        token: `token-${sessionId}`,
        tokenEnv: "PANNEL_HANDLE_REMOTE_AGENT_TOKEN"
      })),
      runConfiguredCommand: vi.fn(async () => ({ exitCode: 0 })),
      closeBinding: vi.fn(async () => {})
    };
    const mocks = createMocks({ remoteAgentBridgeService });
    await mocks.launcher.createSession({
      type: "ssh",
      cwd: "/srv/app",
      agentProvider: currentProvider,
      agentLocation: "local",
      localAgentCwd: "C:\\local-agent",
      sshConfig: { host: "example.com" },
      persist: true
    });
    mocks.terminalManager.closeSession.mockClear();
    mocks.terminalManager.launchSession.mockClear();

    const result = await mocks.launcher.switchAgent("run-1", targetProvider);

    expect(mocks.terminalManager.closeSession).toHaveBeenCalledWith("run-1");
    expect(mocks.terminalManager.launchSession).toHaveBeenCalledWith(expect.objectContaining({
      agentProvider: targetProvider,
      agentLocation: "local",
      localAgentCwd: "C:\\local-agent",
      cwd: "/srv/app"
    }), expect.objectContaining({
      useProvidedTemplate: true,
      templateId: "1",
      deferTerminalStart: true
    }));
    expect(remoteAgentBridgeService.createBinding).toHaveBeenLastCalledWith("run-2");
    expect(mocks.hookConfigManager.inspect).toHaveBeenLastCalledWith(
      { type: "windows", path: "C:\\runtime\\run-2" },
      [targetProvider]
    );
    if (targetProvider === "codebuddy") {
      const runtime = mocks.terminalManager.startDeferredSession.mock.calls.at(-1)[1];
      expect(runtime.runtimeEnv.PANNEL_HANDLE_REMOTE_AGENT_INSTRUCTIONS)
        .toBe("Use the remote workspace.\nUse only remote tools.");
      expect(runtime.runtimeInitialCommand).toContain('"$env:PANNEL_HANDLE_REMOTE_AGENT_INSTRUCTIONS"');
      expect(runtime.runtimeInitialCommand).not.toMatch(/[\r\n]/);
    }
    expect(result).toMatchObject({ id: "run-2", agentProvider: targetProvider, terminalTransport: "local-agent" });
  });

  it("keeps the current local bridge open when the target CLI is unavailable", async () => {
    const mocks = createMocks();
    mocks.terminalManager.getSession.mockReturnValue({
      id: "run-1",
      templateId: "1",
      type: "ssh",
      cwd: "/srv/app",
      agentProvider: "codex",
      agentLocation: "local",
      sshConfig: { host: "example.com" }
    });
    mocks.spawnSync.mockReturnValueOnce({ status: 1, stdout: "" });

    await expect(mocks.launcher.switchAgent("run-1", "opencode")).rejects.toThrow("opencode");
    expect(mocks.terminalManager.closeSession).not.toHaveBeenCalled();
    expect(mocks.terminalManager.launchSession).not.toHaveBeenCalled();
  });
});
