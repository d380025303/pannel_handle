import { execFile, execFileSync } from "node:child_process";
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
      const session = { ...template, id: `run-${nextRuntimeId++}`, templateId,
        ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}) };
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
  const sshSessionRuntime = { exec: vi.fn((_id, command) => Promise.resolve(command.includes("opencode --version") ? "opencode v2.0.18" : "/usr/bin/agent")) };
  const sshHookTunnelService = { ensureTunnel: vi.fn(() => Promise.resolve({ hookUrl: "http://127.0.0.1:9000/opencode-hook" })) };
  const spawnSync = vi.fn((command, args) => {
    const invocation = `${command} ${(args || []).join(" ")}`;
    if (invocation.includes("codebuddy --version")) return { status: 0, stdout: "2.137.1" };
    if (invocation.includes("gemini --version")) return { status: 0, stdout: "0.56.0" };
    if (invocation.includes("grok --version")) return { status: 0, stdout: "grok 0.2.106" };
    if (invocation.includes("opencode --version")) return { status: 0, stdout: "opencode v2.0.18" };
    return { status: 0, stdout: "found" };
  });
  const getDefaultShell = vi.fn(() => "C:\\Windows\\System32\\cmd.exe");
  const mockExecFile = vi.fn((file, args, options, callback) => {
    const result = (overrides.spawnSync || spawnSync)(file, args, options);
    callback(result.error || (result.status ? Object.assign(new Error("command failed"), { code: result.status }) : null),
      result.stdout || "", result.stderr || "");
  });
  const sessionStore = {
    getTemplate: vi.fn(() => undefined),
    updateLibrary: vi.fn(),
    normalizeTemplate: vi.fn((template) => ({
      id: template.id,
      title: template.title,
      shell: template.shell,
      cwd: template.cwd,
      createdAt: template.createdAt,
      initialCommand: template.initialCommand,
      agentProvider: template.agentProvider,
      agentLocation: template.agentLocation,
      localAgentCwd: template.localAgentCwd,
      modelSource: template.modelSource,
      modelId: template.modelId,
      codexBackend: template.codexBackend,
      codexModel: template.codexModel,
      codexExperimentalAcknowledged: template.codexExperimentalAcknowledged,
      graphicalSessionEnabled: template.graphicalSessionEnabled,
      type: template.type,
      wslDistro: template.wslDistro,
      sshConfig: template.sshConfig,
      quickCommands: template.quickCommands || [],
      tags: template.tags || []
    }))
  };
  const launcher = createAgentSessionLauncher({
    terminalManager,
    sessionStore,
    hookConfigManager,
    remoteHookConfigService,
    sshSessionRuntime,
    sshHookTunnelService,
    onTemplateLaunched,
    spawnSync,
    execFile: mockExecFile,
    getDefaultShell,
    ...overrides
  });
  return { launcher, terminalManager, sessionStore, hookConfigManager, remoteHookConfigService, sshSessionRuntime, sshHookTunnelService, onTemplateLaunched, spawnSync, execFile: mockExecFile, getDefaultShell, sessions };
}

describe("agent-session-launcher", () => {
  it("keeps injected tool credentials out of terminal sessions and passes them only to Codex runtime", async () => {
    const service = { start: vi.fn(async () => {}) };
    const mocks = createMocks({ codexAppServerSessionService: service });
    const injectedTools = { tools: [{ name: "lookup" }], toolCallback: { url: "http://localhost/tools", bearerToken: "secret" } };
    await mocks.launcher.launchSession({ id: "saved", type: "windows", cwd: "C:\\work", agentProvider: "codex", graphicalSessionEnabled: true },
      { useProvidedTemplate: true, templateId: undefined, injectedTools });
    expect(service.start.mock.calls[0][1].injectedTools).toEqual(injectedTools);
    expect(JSON.stringify(mocks.sessions)).not.toContain("secret");
    expect(JSON.stringify(mocks.terminalManager.launchSession.mock.calls)).not.toContain("secret");
  });
  it.each([false, true])("forks into an independent runtime and cleans up on failure=%s", async (fails) => {
    const service = { start: vi.fn(async () => {}), snapshot: vi.fn(() => ({ threadId: "thread-1", busy: false })),
      forkThread: vi.fn(async () => { if (fails) throw new Error("fork failed"); }) };
    const mocks = createMocks({ codexAppServerSessionService: service });
    const source = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codex", graphicalSessionEnabled: true });
    const result = mocks.launcher.forkTurnToNewSession(source.id, "thread-1", "turn-1");
    if (fails) await expect(result).rejects.toThrow("fork failed");
    else expect((await result).id).toBe("run-2");
    expect(service.forkThread).toHaveBeenCalledWith("run-2", "thread-1", "turn-1");
    expect(mocks.terminalManager.getSession(source.id)).toBe(source);
    expect(mocks.sessions).toHaveLength(fails ? 1 : 2);
  });

  it("routes Claude graphical sessions through ACP on Windows, WSL, and SSH", async () => {
    const codexAppServerSessionService = { start: vi.fn(async () => {}) };
    const mocks = createMocks({ codexAppServerSessionService });
    for (const options of [
      { type: "windows", cwd: "C:\\work" },
      { type: "wsl", cwd: "/work", wslDistro: "Ubuntu" },
      { type: "ssh", cwd: "/srv/app", agentLocation: "remote", sshConfig: { host: "example.com" } }
    ]) {
      const result = await mocks.launcher.createSession({ ...options, agentProvider: "claude", graphicalSessionEnabled: true });
      expect(result.runtimeMode).toBe("app-server");
    }
    expect(codexAppServerSessionService.start).toHaveBeenCalledTimes(3);
    expect(mocks.hookConfigManager.inspect).not.toHaveBeenCalled();
  });

  it("uses the restricted bridge for local Claude SSH graphical sessions", async () => {
    const remoteAgentBridgeService = { createBinding: vi.fn(async () => ({ workspacePath: "C:\\bridge", url: "http://127.0.0.1:5678/mcp",
      token: "secret", tokenEnv: "PANNEL_HANDLE_REMOTE_AGENT_TOKEN", runtimeInstructions: "Use remote tools" })),
      runConfiguredCommand: vi.fn(), closeBinding: vi.fn() };
    const codexAppServerSessionService = { start: vi.fn(async () => {}) };
    const mocks = createMocks({ remoteAgentBridgeService, codexAppServerSessionService });
    const result = await mocks.launcher.createSession({ type: "ssh", cwd: "/srv/app", agentProvider: "claude",
      graphicalSessionEnabled: true, agentLocation: "local", sshConfig: { host: "example.com" } });
    expect(result.runtimeMode).toBe("app-server");
    expect(codexAppServerSessionService.start.mock.calls[0][1].remoteBridge).toMatchObject({ url: "http://127.0.0.1:5678/mcp", instructions: "Use remote tools" });
    await expect(mocks.launcher.createSession({ type: "ssh", cwd: "/srv/app", agentProvider: "claude",
      graphicalSessionEnabled: false, agentLocation: "local", sshConfig: { host: "example.com" } })).rejects.toThrow("仅支持图形会话");
  });

  it("rejects OpenCode V1 before launching a managed session", async () => {
    const mocks = createMocks();
    mocks.spawnSync.mockImplementation((command, args) => {
      const invocation = `${command} ${(args || []).join(" ")}`;
      return { status: 0, stdout: invocation.includes("opencode --version") ? "opencode v1.18.29" : "found" };
    });
    await expect(mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "opencode" }))
      .rejects.toThrow("OpenCode V1 不再支持");
    expect(mocks.terminalManager.createSession).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: "windows", cwd: "C:\\work" }, "Get-Command opencode -All"],
    [{ type: "wsl", cwd: "/work", wslDistro: "Ubuntu" }, "command -v opencode"],
    [{ type: "ssh", cwd: "/srv/app", agentLocation: "remote", sshConfig: { host: "example.com" } }, "command -v opencode"],
    [{ type: "ssh", cwd: "/srv/app", agentLocation: "local", sshConfig: { host: "example.com" } }, "Get-Command opencode -All"]
  ])("shows recovery commands and keeps the current session when switching to OpenCode V1 in %j", async (target, inspectCommand) => {
    const mocks = createMocks();
    mocks.terminalManager.getSession.mockReturnValue({ id: "run-1", templateId: "1", agentProvider: "codex", ...target });
    mocks.spawnSync.mockImplementation((command, args) => ({
      status: 0,
      stdout: `${command} ${(args || []).join(" ")}`.includes("opencode --version") ? "opencode v1.18.21" : "found"
    }));
    mocks.sshSessionRuntime.exec.mockImplementation((_id, command) => Promise.resolve(command.includes("opencode --version") ? "opencode v1.18.21" : "/usr/bin/opencode"));

    let error;
    try {
      await mocks.launcher.switchAgent("run-1", "opencode");
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toContain("OpenCode V1 不再支持（当前 1.18.21）");
    expect(error?.message).toContain("npm uninstall -g opencode-ai");
    expect(error?.message).toContain("npm install -g @opencode/cli");
    expect(error?.message).toContain(inspectCommand);
    expect(error?.message).toContain("opencode --version");
    expect(mocks.terminalManager.closeSession).not.toHaveBeenCalled();
  });

  it("shows recovery commands when the remote OpenCode version cannot be read", async () => {
    const mocks = createMocks();
    mocks.terminalManager.getSession.mockReturnValue({ id: "run-1", templateId: "1", type: "ssh", cwd: "/srv/app",
      agentProvider: "codex", agentLocation: "remote", sshConfig: { host: "example.com" } });
    mocks.sshSessionRuntime.exec.mockImplementation((_id, command) => command.includes("opencode --version")
      ? Promise.reject(new Error("remote command failed")) : Promise.resolve("/usr/bin/opencode"));

    await expect(mocks.launcher.switchAgent("run-1", "opencode"))
      .rejects.toThrow("npm install -g @opencode/cli");
    expect(mocks.terminalManager.closeSession).not.toHaveBeenCalled();
  });

  it("routes explicitly enabled OpenCode Windows, WSL, and SSH remote sessions to ACP", async () => {
    const codexAppServerSessionService = { start: vi.fn(async () => {}) };
    const mocks = createMocks({ codexAppServerSessionService });
    for (const options of [
      { type: "windows", cwd: "C:\\work" },
      { type: "wsl", cwd: "/work", wslDistro: "Ubuntu" },
      { type: "ssh", cwd: "/srv/app", agentLocation: "remote", sshConfig: { host: "example.com" } }
    ]) {
      const result = await mocks.launcher.createSession({ ...options, agentProvider: "opencode", graphicalSessionEnabled: true });
      expect(result).toMatchObject({ runtimeMode: "app-server", deferTerminalStart: true });
    }
    expect(codexAppServerSessionService.start).toHaveBeenCalledTimes(3);
    expect(mocks.remoteHookConfigService.inspect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: expect.any(String), path: "/srv/app" }), ["opencode"]);
    const terminal = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "opencode", graphicalSessionEnabled: false });
    expect(terminal.runtimeMode).toBeUndefined();
  });
  it("passes verified service keys to local OpenCode ACP sessions", async () => {
    const codexAppServerSessionService = { start: vi.fn(async () => {}) };
    const openCodeModelSync = { syncWindows: vi.fn(), syncWsl: vi.fn() };
    const miniMaxService = { getLaunchConfig: vi.fn(async () => null),
      getOpenCodeRuntimeEnv: vi.fn(() => ({ MINIMAX_API_KEY: "secret" })) };
    const mocks = createMocks({ codexAppServerSessionService, openCodeModelSync, miniMaxService });
    await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "opencode", graphicalSessionEnabled: true });
    await mocks.launcher.createSession({ type: "wsl", cwd: "/work", wslDistro: "Ubuntu", agentProvider: "opencode", graphicalSessionEnabled: true });
    for (const [, runtime] of codexAppServerSessionService.start.mock.calls) {
      expect(runtime.runtimeEnv.MINIMAX_API_KEY).toBe("secret");
    }
    expect(openCodeModelSync.syncWindows).toHaveBeenCalledOnce();
    expect(openCodeModelSync.syncWsl).toHaveBeenCalledWith("Ubuntu");
  });
  it("routes opted-in CodeBuddy Windows, WSL, and SSH remote sessions to ACP", async () => {
    const codexAppServerSessionService = { start: vi.fn(async () => {}) };
    const mocks = createMocks({ codexAppServerSessionService });
    for (const options of [
      { type: "windows", cwd: "C:\\work" },
      { type: "wsl", cwd: "/work", wslDistro: "Ubuntu" },
      { type: "ssh", cwd: "/srv/app", agentLocation: "remote", sshConfig: { host: "example.com" } }
    ]) {
      const result = await mocks.launcher.createSession({ ...options, agentProvider: "codebuddy", graphicalSessionEnabled: true });
      expect(result).toMatchObject({ runtimeMode: "app-server", deferTerminalStart: true });
    }
    expect(codexAppServerSessionService.start).toHaveBeenCalledTimes(3);
    const legacy = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codebuddy", graphicalSessionEnabled: false });
    expect(legacy.runtimeMode).toBeUndefined();
  });
  it("uses each local Codex template's App Server setting", async () => {
    const codexAppServerSessionService = { start: vi.fn().mockResolvedValue({}) };
    const mocks = createMocks({
      codexAppServerSessionService
    });
    const first = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codex" });
    expect(first).toMatchObject({ runtimeMode: "app-server", deferTerminalStart: true });
    expect(codexAppServerSessionService.start).toHaveBeenCalledWith(first, expect.any(Object));
    const second = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codex", graphicalSessionEnabled: false });
    expect(second.runtimeMode).toBeUndefined();
    expect(second.deferTerminalStart).toBeUndefined();
    expect(first.runtimeMode).toBe("app-server");
    const savedTemplate = { id: "saved-1", type: "windows", cwd: "C:\\work", agentProvider: "codex", graphicalSessionEnabled: false };
    const launched = await mocks.launcher.launchSession(savedTemplate);
    expect(launched.runtimeMode).toBeUndefined();
    expect(codexAppServerSessionService.start).toHaveBeenCalledTimes(1);
  });
  it("carries the graphical mode through an Agent switch", async () => {
    const codexAppServerSessionService = { start: vi.fn(async () => {}) };
    const mocks = createMocks({ codexAppServerSessionService });
    await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codex", graphicalSessionEnabled: false });
    const terminal = await mocks.launcher.switchAgent("run-1", "opencode");
    expect(terminal.graphicalSessionEnabled).toBe(false);
    expect(terminal.runtimeMode).toBeUndefined();
    expect(codexAppServerSessionService.start).not.toHaveBeenCalled();

    const graphical = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codex", graphicalSessionEnabled: true });
    const switched = await mocks.launcher.switchAgent(graphical.id, "codebuddy");
    expect(switched.graphicalSessionEnabled).toBe(true);
    expect(mocks.terminalManager.launchSession).toHaveBeenLastCalledWith(expect.objectContaining({
      agentProvider: "codebuddy", graphicalSessionEnabled: true
    }), expect.objectContaining({ runtimeMode: "app-server" }));
    expect(codexAppServerSessionService.start).toHaveBeenCalledTimes(2);
  });
  it("carries CodeBuddy choices through switches without changing the template Agent", async () => {
    const mocks = createMocks({ codexAppServerSessionService: { start: vi.fn(async () => {}) } });
    const original = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codex",
      graphicalSessionEnabled: true, persist: true });
    original.codeBuddyGraphicalOptions = { mode: "default", model: "glm-5.3", contextWindow: "1000000", multitask: true };

    const buddy = await mocks.launcher.switchAgent(original.id, "codebuddy");
    const codex = await mocks.launcher.switchAgent(buddy.id, "codex");
    const again = await mocks.launcher.switchAgent(codex.id, "codebuddy");

    expect(again.codeBuddyGraphicalOptions).toEqual(original.codeBuddyGraphicalOptions);
    expect(mocks.sessionStore.updateLibrary).not.toHaveBeenCalledWith("1", expect.objectContaining({ agentProvider: "codebuddy" }));
  });
  it("loads saved OpenCode choices when switching back from another Agent", async () => {
    const mocks = createMocks({ codexAppServerSessionService: { start: vi.fn(async () => {}) } });
    const original = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codex",
      graphicalSessionEnabled: true, persist: true });
    const saved = { mode: "plan", model: "openai/gpt-5.5" };
    mocks.sessionStore.getTemplate.mockReturnValue({ openCodeGraphicalOptions: saved });

    const openCode = await mocks.launcher.switchAgent(original.id, "opencode");
    const codex = await mocks.launcher.switchAgent(openCode.id, "codex");
    const again = await mocks.launcher.switchAgent(codex.id, "opencode");

    expect(again.openCodeGraphicalOptions).toEqual(saved);
    expect(mocks.sessionStore.updateLibrary).not.toHaveBeenCalledWith("1", expect.objectContaining({ agentProvider: "opencode" }));
  });
  it("starts SSH remote Codex through App Server and keeps the opt-out terminal path", async () => {
    const codexAppServerSessionService = { start: vi.fn().mockResolvedValue({}) };
    const mocks = createMocks({ codexAppServerSessionService });
    const options = { type: "ssh", cwd: "/srv/app", agentProvider: "codex", agentLocation: "remote",
      sshConfig: { host: "example.com" } };
    const remote = await mocks.launcher.createSession(options);
    expect(remote).toMatchObject({ runtimeMode: "app-server", deferTerminalStart: true });
    expect(codexAppServerSessionService.start).toHaveBeenCalledWith(remote, {});
    expect(mocks.terminalManager.write).not.toHaveBeenCalled();
    const disabled = await mocks.launcher.createSession({ ...options, graphicalSessionEnabled: false });
    expect(disabled.runtimeMode).toBeUndefined();
    expect(mocks.terminalManager.write).toHaveBeenCalled();
    const template = { ...options, id: "saved-remote" };
    const launched = await mocks.launcher.launchSession(template);
    expect(mocks.terminalManager.launchSession).toHaveBeenLastCalledWith(template, expect.objectContaining({
      runtimeMode: "app-server", deferTerminalStart: true }));
    expect(launched).toBeTruthy();
    expect(codexAppServerSessionService.start).toHaveBeenCalledTimes(2);
  });
  it("closes an SSH App Server session when initialization fails", async () => {
    const mocks = createMocks({ codexAppServerSessionService: { start: vi.fn().mockRejectedValue(new Error("SSH failed")) } });
    await expect(mocks.launcher.createSession({ type: "ssh", cwd: "/srv/app", agentProvider: "codex",
      agentLocation: "remote", sshConfig: { host: "example.com" } })).rejects.toThrow("SSH failed");
    expect(mocks.terminalManager.closeSession).toHaveBeenCalledWith("run-1");
  });
  it("rejects a Windows Codex shim in WSL App Server mode", async () => {
    const mocks = createMocks({
      codexAppServerSessionService: { start: vi.fn() },
      spawnSync: vi.fn((_command, args) => args?.at(-1)?.includes("resolved=$(command -v codex)")
        ? { status: 126 } : { status: 0, stdout: "found" })
    });
    await expect(mocks.launcher.createSession({ type: "wsl", wslDistro: "Ubuntu", cwd: "/repo", agentProvider: "codex" }))
      .rejects.toThrow("Linux Codex CLI");
    expect(mocks.terminalManager.createSession).not.toHaveBeenCalled();
  });
  it("uses the interactive Bash login environment for WSL App Server", async () => {
    const codexAppServerSessionService = { start: vi.fn().mockResolvedValue({}) };
    const mocks = createMocks({ codexAppServerSessionService });
    const session = await mocks.launcher.createSession({ type: "wsl", wslDistro: "ubuntu", cwd: "/repo", agentProvider: "codex" });
    expect(session.runtimeMode).toBe("app-server");
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.execFile).toHaveBeenCalledWith("wsl.exe",
      expect.arrayContaining(["-d", "ubuntu", "bash", "-lic"]), expect.objectContaining({ timeout: 30000 }), expect.any(Function));
    expect(codexAppServerSessionService.start).toHaveBeenCalledWith(session, expect.any(Object));
  });
  it("reports a missing WSL Codex command separately from a Windows shim", async () => {
    const mocks = createMocks({ codexAppServerSessionService: { start: vi.fn() },
      spawnSync: vi.fn(() => ({ status: 127 })) });
    await expect(mocks.launcher.createSession({ type: "wsl", wslDistro: "ubuntu", cwd: "/repo", agentProvider: "codex" }))
      .rejects.toThrow("Bash 登录环境中找到 codex");
  });
  it("reports a timed out WSL Codex command check", async () => {
    const mocks = createMocks({ codexAppServerSessionService: { start: vi.fn() },
      spawnSync: vi.fn(() => ({ error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) })) });
    await expect(mocks.launcher.createSession({ type: "wsl", wslDistro: "ubuntu", cwd: "/repo", agentProvider: "codex" }))
      .rejects.toThrow("命令检测超时");
  });
  it("keeps timers and another session responsive during a 1500ms WSL graphical check", async () => {
    let checkFinished = false;
    const service = { start: vi.fn(async () => {}) };
    const mocks = createMocks({ codexAppServerSessionService: service,
      execFile: (_file, _args, options, callback) => execFile(process.execPath,
        ["-e", "setTimeout(() => {}, 1500)"], options, (...result) => {
          checkFinished = true;
          callback(...result);
        }) });
    const started = performance.now();
    const timer = new Promise(resolve => setTimeout(() => resolve({ elapsed: performance.now() - started, checkFinished }), 10));
    const pending = mocks.launcher.createSession({ type: "wsl", wslDistro: "Ubuntu", cwd: "/repo", agentProvider: "codex" });
    const windowsSession = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codex" });
    const observation = await timer;
    const otherSessionFinishedBeforeCheck = !checkFinished;
    const wslSession = await pending;
    expect(observation.checkFinished).toBe(false);
    expect(observation.elapsed).toBeLessThan(750);
    expect(otherSessionFinishedBeforeCheck).toBe(true);
    expect(windowsSession.runtimeMode).toBe("app-server");
    expect(wslSession.runtimeMode).toBe("app-server");
    expect(service.start).toHaveBeenCalledTimes(2);
  });
  it.each([
    [126, "Linux Codex CLI"],
    [127, "Bash 登录环境中找到 codex"],
    [1, "退出代码 1"]
  ])("preserves WSL errors for real async child exit %s", async (code, message) => {
    const mocks = createMocks({ codexAppServerSessionService: { start: vi.fn() },
      execFile: (_file, _args, options, callback) => execFile(process.execPath,
        ["-e", `process.stderr.write('check failed'); process.exit(${code})`], options, callback) });
    await expect(mocks.launcher.createSession({ type: "wsl", wslDistro: "Ubuntu", cwd: "/repo", agentProvider: "codex" }))
      .rejects.toThrow(message);
    expect(mocks.terminalManager.createSession).not.toHaveBeenCalled();
  });
  it("normalizes a real execFile timeout to the existing WSL timeout error", async () => {
    const mocks = createMocks({ codexAppServerSessionService: { start: vi.fn() },
      execFile: (_file, _args, options, callback) => execFile(process.execPath,
        ["-e", "setTimeout(() => {}, 1500)"], { ...options, timeout: 100 }, callback) });
    await expect(mocks.launcher.createSession({ type: "wsl", wslDistro: "Ubuntu", cwd: "/repo", agentProvider: "codex" }))
      .rejects.toThrow("命令检测超时");
    expect(mocks.terminalManager.createSession).not.toHaveBeenCalled();
  });
  it("preserves WSL process launch errors", async () => {
    const mocks = createMocks({ codexAppServerSessionService: { start: vi.fn() },
      execFile: (_file, _args, options, callback) => execFile(`${process.execPath}.missing`, [], options, callback) });
    await expect(mocks.launcher.createSession({ type: "wsl", wslDistro: "Ubuntu", cwd: "/repo", agentProvider: "codex" }))
      .rejects.toThrow("无法检测 WSL Ubuntu 中的 Codex 命令");
    expect(mocks.terminalManager.createSession).not.toHaveBeenCalled();
  });
  it("duplicates a persisted running session from its saved template", async () => {
    const mocks = createMocks();
    const template = {
      id: "template-1",
      title: "Workspace",
      shell: "powershell.exe",
      cwd: "C:\\work",
      createdAt: 1,
      type: "windows",
      quickCommands: [],
      tags: ["crm"]
    };
    mocks.sessions.push({ ...template, id: "run-source", templateId: template.id, title: "Workspace #2" });
    mocks.sessionStore.getTemplate.mockReturnValue(template);

    const duplicated = await mocks.launcher.duplicateRunningSession("run-source");

    expect(duplicated).toMatchObject({ id: "run-1", templateId: template.id, title: template.title });
    expect(mocks.terminalManager.launchSession).toHaveBeenCalledWith(template, {});
    expect(mocks.onTemplateLaunched).toHaveBeenCalledWith(template.id);
    expect(mocks.sessionStore.normalizeTemplate).not.toHaveBeenCalled();
  });

  it("duplicates a transient running session without creating a template link", async () => {
    const mocks = createMocks();
    const source = {
      id: "run-source",
      title: "Temporary",
      shell: "powershell.exe",
      cwd: "C:\\work",
      createdAt: 1,
      type: "windows",
      initialCommand: "pnpm dev",
      quickCommands: [{ id: "test", command: "pnpm test", mode: "write" }],
      tags: ["local"]
    };
    mocks.sessions.push(source);

    const duplicated = await mocks.launcher.duplicateRunningSession(source.id);

    expect(duplicated).toMatchObject({
      id: "run-1",
      templateId: undefined,
      initialCommand: source.initialCommand,
      quickCommands: source.quickCommands,
      tags: source.tags
    });
    expect(mocks.terminalManager.launchSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: source.id, cwd: source.cwd }),
      { useProvidedTemplate: true, templateId: undefined }
    );
    expect(mocks.onTemplateLaunched).not.toHaveBeenCalled();
  });

  it("rejects duplication when the source session is no longer running", async () => {
    const { launcher } = createMocks();
    await expect(launcher.duplicateRunningSession("missing")).rejects.toThrow("Session is not running.");
  });

  it("opens the other mode from the running instance without changing its template or closing it", async () => {
    const codexAppServerSessionService = { start: vi.fn(async () => {}) };
    const mocks = createMocks({ codexAppServerSessionService });
    const source = { id: "run-source", templateId: "saved-1", title: "Live title", shell: "powershell.exe",
      cwd: "C:\\live", createdAt: 1, type: "windows", agentProvider: "codex",
      graphicalSessionEnabled: false, runtimeMode: "terminal", quickCommands: [{ id: "q", command: "pwd" }] };
    mocks.sessions.push(source);
    mocks.sessionStore.getTemplate.mockReturnValue({ ...source, title: "Old title", cwd: "C:\\saved" });

    const graphical = await mocks.launcher.openOtherSessionMode(source.id);
    expect(graphical).toMatchObject({ id: "run-1", templateId: "saved-1", title: "Live title",
      cwd: "C:\\live", graphicalSessionEnabled: true, runtimeMode: "app-server" });
    expect(mocks.terminalManager.closeSession).not.toHaveBeenCalled();
    expect(mocks.sessions).toContain(source);
    expect(mocks.sessionStore.updateLibrary).not.toHaveBeenCalled();
    expect(mocks.onTemplateLaunched).not.toHaveBeenCalled();
    expect(mocks.terminalManager.launchSession).toHaveBeenCalledWith(expect.objectContaining({ graphicalSessionEnabled: true }),
      expect.objectContaining({ useProvidedTemplate: true, templateId: "saved-1" }));

    const terminal = await mocks.launcher.openOtherSessionMode(graphical.id);
    expect(terminal).toMatchObject({ id: "run-2", templateId: "saved-1", graphicalSessionEnabled: false });
    expect(codexAppServerSessionService.start).toHaveBeenCalledTimes(1);
    expect(mocks.sessions).toHaveLength(3);
  });

  it("opens a transient Agent instance in the other mode and rejects unsupported targets", async () => {
    const mocks = createMocks({ codexAppServerSessionService: { start: vi.fn(async () => {}) } });
    mocks.sessions.push({ id: "temporary", title: "Temporary", shell: "powershell.exe", cwd: "C:\\work",
      type: "windows", agentProvider: "opencode", runtimeMode: "terminal", graphicalSessionEnabled: false });
    const opened = await mocks.launcher.openOtherSessionMode("temporary");
    expect(opened).toMatchObject({ templateId: undefined, graphicalSessionEnabled: true, runtimeMode: "app-server" });
    expect(mocks.terminalManager.launchSession).toHaveBeenCalledWith(expect.any(Object),
      expect.objectContaining({ templateId: undefined }));
    mocks.sessions.push({ id: "shell", type: "windows" });
    await expect(mocks.launcher.openOtherSessionMode("shell")).rejects.toThrow("不支持");
    await expect(mocks.launcher.openOtherSessionMode("missing")).rejects.toThrow("Session is not running.");
    mocks.sessions.push({ id: "ssh-claude", title: "Claude", shell: "ssh2", cwd: "/work", type: "ssh",
      agentProvider: "claude", agentLocation: "local", runtimeMode: "app-server", graphicalSessionEnabled: true });
    await expect(mocks.launcher.openOtherSessionMode("ssh-claude")).rejects.toThrow("仅支持图形");
    expect(mocks.terminalManager.closeSession).not.toHaveBeenCalled();
  });

  it("keeps the original instance when the new graphical mode fails to start", async () => {
    const mocks = createMocks({ codexAppServerSessionService: { start: vi.fn(async () => { throw new Error("ACP unavailable"); }) } });
    const source = { id: "original", title: "Codex", shell: "powershell.exe", cwd: "C:\\work",
      type: "windows", agentProvider: "codex", runtimeMode: "terminal", graphicalSessionEnabled: false };
    mocks.sessions.push(source);
    await expect(mocks.launcher.openOtherSessionMode(source.id)).rejects.toThrow("ACP unavailable");
    expect(mocks.sessions).toEqual([source]);
    expect(mocks.terminalManager.closeSession).toHaveBeenCalledWith("run-1");
    expect(mocks.terminalManager.closeSession).not.toHaveBeenCalledWith(source.id);
  });

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

  it("resolves the selected Windows shell before composing the Agent command", async () => {
    const current = createMocks();
    current.getDefaultShell.mockReturnValue("pwsh.exe");
    await current.launcher.createSession({ type: "windows", windowsShell: "pwsh", cwd: "C:\\work", agentProvider: "claude", initialCommand: "$env:TEST = 'ok'" });
    expect(current.getDefaultShell).toHaveBeenCalledWith("pwsh");
    expect(current.terminalManager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      shell: "pwsh.exe",
      runtimeInitialCommand: expect.stringContaining("& { $env:TEST = 'ok' }; if ($?) { claude }")
    }));
  });

  it.skipIf(process.platform !== "win32")("runs CMD proxy setup and inherits it in a child without network access", () => {
    const command = buildAgentStartCommand({
      type: "windows", shell: "cmd.exe", agentProvider: "claude",
      initialCommand: 'chcp 65001 && set "HTTP_PROXY=http://127.0.0.1:7892" && set "HTTPS_PROXY=http://127.0.0.1:7892"'
    }).replace(/ && claude$/, ' && cmd.exe /d /c set HTTP_PROXY && cmd.exe /d /c set HTTPS_PROXY');
    const output = execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/q"], {
      input: command + "\r\nexit\r\n",
      encoding: "utf8", windowsHide: true, timeout: 5000,
      env: { ...process.env, HTTP_PROXY: "before", HTTPS_PROXY: "before" }
    });
    expect(output).toMatch(/^HTTP_PROXY=http:\/\/127\.0\.0\.1:7892\r?$/m);
    expect(output).toMatch(/^HTTPS_PROXY=http:\/\/127\.0\.0\.1:7892\r?$/m);
  });

  it("preserves PowerShell syntax for an explicit PowerShell session", () => {
    expect(buildAgentStartCommand({ type: "windows", shell: "pwsh.exe", agentProvider: "claude", initialCommand: "pnpm install" }))
      .toBe("& { pnpm install }; if ($?) { claude }");
  });

  it("builds POSIX Agent commands for WSL and SSH", () => {
    expect(buildAgentStartCommand({ type: "wsl", agentProvider: "codex", initialCommand: "pnpm install" }))
      .toBe("pnpm install && codex");
    expect(buildAgentStartCommand({ type: "ssh", agentProvider: "opencode" }, { hookUrl: "http://local/hook", sessionId: "run-2" }))
      .toContain("PANNEL_HANDLE_SESSION_ID='run-2' opencode --standalone");
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
    expect(config.default_agent).toBe("pannel-handle-remote");

    expect(config.mcp.servers.pannel_handle_remote).toEqual(expect.objectContaining({
      type: "remote",
      url: binding.url,
      codemode: false,
      oauth: false,
      headers: { Authorization: "Bearer {env:PANNEL_HANDLE_REMOTE_AGENT_TOKEN}" }
    }));
    expect(config.agents["pannel-handle-remote"]).toEqual(expect.objectContaining({
      mode: "primary",
      system: binding.developerInstructions,
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "pannel_handle_remote_*", resource: "*", effect: "allow" }
      ]
    }));
    expect(configText).not.toContain(binding.token);
    expect(buildLocalOpenCodeStartCommand(binding)).toBe("opencode --standalone 'C:\\runtime\\run-1'");
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

    expect(Object.keys(config.mcpServers)).toEqual(["pannel_handle_remote"]);
    expect(config.mcpServers.pannel_handle_remote).toEqual({
      type: "http",
      url: binding.url,
      headers: { Authorization: "Bearer ${PANNEL_HANDLE_REMOTE_AGENT_TOKEN}" }
    });
    expect(command).toContain("--strict-mcp-config");
    expect(command).toContain("--tools Read,Glob,Grep");
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

  it("injects only the NaraRouter bridge token and binds it to the session", async () => {
    const naraRouterService = { getLaunchConfig: vi.fn(() => ({
      providerId: "nararouter",
      providerName: "NaraRouter",
      baseUrl: "http://127.0.0.1:4568/v1",
      apiKeyEnv: "PANNEL_HANDLE_NARAROUTER_BRIDGE_KEY",
      apiKey: "nara-session-token",
      catalogPath: "C:\\Data\\nararouter-models.json",
      model: "gpt-test",
      registrationId: "launch:nara",
      bridgeRegistration: { backend: "nararouter", id: "launch:nara" }
    })) };
    const codexModelBridgeModule = { bindSession: vi.fn(), releaseRegistration: vi.fn() };
    const mocks = createMocks({ naraRouterService, codexModelBridgeModule });
    await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codex", codexBackend: "nararouter", codexModel: "gpt-test" });
    expect(mocks.terminalManager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      runtimeEnv: { PANNEL_HANDLE_NARAROUTER_BRIDGE_KEY: "nara-session-token" },
      runtimeWslEnvKeys: ["PANNEL_HANDLE_NARAROUTER_BRIDGE_KEY"],
      runtimeInitialCommand: expect.not.stringContaining("nara-session-token")
    }));
    expect(codexModelBridgeModule.bindSession).toHaveBeenCalledWith(expect.any(String), { backend: "nararouter", id: "launch:nara" });
  });

  it("injects only the MiniMax bridge token and binds it to the session", async () => {
    const miniMaxService = { getLaunchConfig: vi.fn(() => ({
      providerId: "minimax",
      providerName: "MiniMax",
      baseUrl: "http://127.0.0.1:4569/v1",
      apiKeyEnv: "PANNEL_HANDLE_MINIMAX_BRIDGE_KEY",
      apiKey: "minimax-session-token",
      catalogPath: "C:\\Data\\minimax-models.json",
      model: "MiniMax-M2.5",
      registrationId: "launch:minimax",
      bridgeRegistration: { backend: "minimax", id: "launch:minimax" }
    })) };
    const codexModelBridgeModule = { bindSession: vi.fn(), releaseRegistration: vi.fn() };
    const mocks = createMocks({ miniMaxService, codexModelBridgeModule });

    await mocks.launcher.createSession({ type: "wsl", wslDistro: "Ubuntu", cwd: "/work", agentProvider: "codex", codexBackend: "minimax", codexModel: "MiniMax-M2.5" });

    expect(mocks.terminalManager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      runtimeEnv: { PANNEL_HANDLE_MINIMAX_BRIDGE_KEY: "minimax-session-token" },
      runtimeWslEnvKeys: ["PANNEL_HANDLE_MINIMAX_BRIDGE_KEY"],
      runtimeInitialCommand: expect.not.stringContaining("minimax-session-token")
    }));
    expect(codexModelBridgeModule.bindSession).toHaveBeenCalledWith(expect.any(String), { backend: "minimax", id: "launch:minimax" });
  });

  it("moves legacy CodeBuddy Codex requests to the OpenAI backend", async () => {
    const mocks = createMocks();
    await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codex",
      codexBackend: "codebuddy", codexModel: "glm-5.3", graphicalSessionEnabled: false });
    expect(mocks.terminalManager.createSession).toHaveBeenCalledWith(expect.objectContaining({
      codexBackend: "openai", modelSource: "native", codexModel: undefined
    }));
  });

  it("rejects switching Codex to the removed CodeBuddy backend", async () => {
    const mocks = createMocks();
    mocks.sessions.push({ id: "run-1", agentProvider: "codex", type: "windows" });
    await expect(mocks.launcher.switchModelSource("run-1", "codebuddy"))
      .rejects.toThrow("Unsupported Codex backend: codebuddy");
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

  it("injects separate Codex hook environments when creating and restoring SSH sessions", async () => {
    const mocks = createMocks();
    mocks.sshHookTunnelService.ensureTunnel.mockImplementation(async id => ({
      hookUrl: `http://127.0.0.1:${id === "run-1" ? 9101 : 9102}/claude-hook`
    }));
    const template = { id: "template-1", type: "ssh", cwd: "/srv/app", agentProvider: "codex", initialCommand: "echo ready", sshConfig: { host: "example.com" } };
    await mocks.launcher.createSession(template);
    await mocks.launcher.launchSession(template);
    expect(mocks.remoteHookConfigService.install).not.toHaveBeenCalled();
    for (const [id, port] of [["run-1", 9101], ["run-2", 9102]]) {
      expect(mocks.sshHookTunnelService.ensureTunnel).toHaveBeenCalledWith(id);
      expect(mocks.terminalManager.write).toHaveBeenCalledWith(id, expect.stringContaining(
        `cd '/srv/app' && echo ready && PANNEL_HANDLE_HOOK_URL='http://127.0.0.1:${port}/claude-hook' PANNEL_HANDLE_SESSION_ID='${id}' codex;`
      ));
    }
  });

  it("launches OpenCode with a verified external model without placing the key in the command", async () => {
    const launch = { providerId: "openrouter", providerName: "OpenRouter", model: "vendor/coder", baseUrl: "https://openrouter.ai/api/v1", apiKey: "private-key", apiKeyEnv: "OPENROUTER_API_KEY" };
    const openRouterService = { getLaunchConfig: vi.fn(() => null), getAgentLaunchConfig: vi.fn(() => launch) };
    const mocks = createMocks({ openRouterService });
    await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "opencode", modelSource: "openrouter", modelId: "vendor/coder", graphicalSessionEnabled: false });
    const options = mocks.terminalManager.createSession.mock.calls[0][0];
    expect(options.runtimeEnv.OPENROUTER_API_KEY).toBe("private-key");
    expect(JSON.parse(options.runtimeEnv.OPENCODE_CONFIG_CONTENT).model).toBe("openrouter/vendor/coder");
    expect(options.runtimeInitialCommand).not.toContain("private-key");
  });

  it("passes a verified MiniMax model to CodeBuddy ACP through its process environment", async () => {
    const launch = { providerId: "minimax", providerName: "MiniMax", model: "MiniMax-M2", baseUrl: "https://api.minimaxi.com/v1", apiKey: "private-key", apiKeyEnv: "MINIMAX_API_KEY" };
    const miniMaxService = { getLaunchConfig: vi.fn(() => null), getAgentLaunchConfig: vi.fn(() => launch) };
    const codexAppServerSessionService = { start: vi.fn(async () => {}) };
    const mocks = createMocks({ miniMaxService, codexAppServerSessionService });
    await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codebuddy", modelSource: "minimax", modelId: "MiniMax-M2", graphicalSessionEnabled: true });
    const runtime = codexAppServerSessionService.start.mock.calls[0][1];
    expect(runtime.runtimeEnv).toMatchObject({ CODEBUDDY_API_KEY: "private-key", CODEBUDDY_BASE_URL: launch.baseUrl, CODEBUDDY_MODEL: launch.model });
    expect(JSON.parse(runtime.runtimeEnv.ACC_PRODUCT_CONFIG_V3).models).toContainEqual({
      id: launch.model, name: launch.model, url: launch.baseUrl, tags: ["custom"]
    });
    expect(mocks.terminalManager.createSession.mock.calls[0][0].runtimeInitialCommand).not.toContain("private-key");
  });

  it("requires a model before replacing an OpenCode session", async () => {
    const openRouterService = { getLaunchConfig: vi.fn(() => null), getConfig: vi.fn(async () => ({})),
      getAgentLaunchConfig: vi.fn(() => { throw new Error("尚未通过 OpenCode 验证"); }) };
    const mocks = createMocks({ openRouterService });
    const initial = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "opencode", graphicalSessionEnabled: false });
    await expect(mocks.launcher.switchModelSource(initial.id, "openrouter")).rejects.toThrow("请选择 openrouter 模型");
    expect(mocks.terminalManager.getSession(initial.id)).toBeDefined();
    expect(mocks.terminalManager.closeSession).not.toHaveBeenCalled();
  });
  it("switches a graphical CodeBuddy session to a selected verified model", async () => {
    const openRouterService = { getLaunchConfig: vi.fn(() => null), getConfig: vi.fn(async () => ({ defaultModelId: "other" })),
      getAgentLaunchConfig: vi.fn((_agent, model) => {
        if (model !== "vendor/verified") throw new Error("尚未通过 CodeBuddy 验证");
        return { providerId: "openrouter", providerName: "OpenRouter", model, baseUrl: "https://openrouter.ai/api/v1", apiKey: "secret", apiKeyEnv: "OPENROUTER_API_KEY" };
      }) };
    const codexAppServerSessionService = { start: vi.fn(async () => {}) };
    const mocks = createMocks({ openRouterService, codexAppServerSessionService });
    const initial = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codebuddy", graphicalSessionEnabled: true });
    await expect(mocks.launcher.switchModelSource(initial.id, "openrouter", true, "vendor/rejected")).rejects.toThrow("尚未通过 CodeBuddy 验证");
    expect(mocks.terminalManager.getSession(initial.id)).toBeDefined();
    const replacement = await mocks.launcher.switchModelSource(initial.id, "openrouter", true, "vendor/verified");
    expect(replacement).toMatchObject({ modelSource: "openrouter", modelId: "vendor/verified" });
    expect(mocks.terminalManager.getSession(initial.id)).toBeUndefined();
  });
  it("keeps the selected MiniMax model when the service default is unverified", async () => {
    const miniMaxService = { getLaunchConfig: vi.fn(() => null), getConfig: vi.fn(async () => ({ defaultModelId: "MiniMax-M3" })),
      getAgentLaunchConfig: vi.fn((_agent, model) => {
        if (model !== "MiniMax-M2.7") throw new Error(`MiniMax 模型尚未通过 CodeBuddy 验证：${model}`);
        return { providerId: "minimax", providerName: "MiniMax", model, baseUrl: "https://api.minimaxi.com/v1", apiKey: "secret", apiKeyEnv: "MINIMAX_API_KEY" };
      }) };
    const mocks = createMocks({ miniMaxService, codexAppServerSessionService: { start: vi.fn(async () => {}) } });
    const initial = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codebuddy", graphicalSessionEnabled: true });
    const replacement = await mocks.launcher.switchModelSource(initial.id, "minimax", true, "MiniMax-M2.7");
    expect(replacement).toMatchObject({ modelSource: "minimax", modelId: "MiniMax-M2.7" });
    expect(miniMaxService.getAgentLaunchConfig).toHaveBeenCalledWith("codebuddy", "MiniMax-M2.7");
  });

  it("starts Gemini graphically on Windows and WSL while preserving terminal mode", async () => {
    const codexAppServerSessionService = { start: vi.fn(async () => {}) };
    const mocks = createMocks({ codexAppServerSessionService });
    const windows = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "gemini", graphicalSessionEnabled: true });
    const wsl = await mocks.launcher.createSession({ type: "wsl", wslDistro: "Ubuntu", cwd: "/work", agentProvider: "gemini", graphicalSessionEnabled: true });
    const terminal = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "gemini", graphicalSessionEnabled: false });
    expect([windows.runtimeMode, wsl.runtimeMode, terminal.runtimeMode]).toEqual(["app-server", "app-server", undefined]);
    expect(codexAppServerSessionService.start).toHaveBeenCalledTimes(2);
    expect(codexAppServerSessionService.start.mock.calls[0][1].acpArgs).toBe("--acp");
    expect(mocks.spawnSync.mock.calls.some(([command, args]) => command === "wsl.exe" && args.some(value => String(value).includes("command -v gemini")))).toBe(true);
    const legacy = createMocks({ codexAppServerSessionService, spawnSync: vi.fn((command, args) =>
      String(args?.at(-1)).includes("gemini --version") ? { status: 0, stdout: "0.26.0" } : { status: 0, stdout: "found" }) });
    await legacy.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "gemini", graphicalSessionEnabled: true });
    expect(codexAppServerSessionService.start.mock.lastCall[1].acpArgs).toBe("--experimental-acp");
  });

  it("starts Grok graphically on Windows and WSL while preserving terminal mode", async () => {
    const codexAppServerSessionService = { start: vi.fn(async () => {}) };
    const mocks = createMocks({ codexAppServerSessionService });
    const windows = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "grok", graphicalSessionEnabled: true });
    const wsl = await mocks.launcher.createSession({ type: "wsl", wslDistro: "Ubuntu", cwd: "/work", agentProvider: "grok", graphicalSessionEnabled: true });
    const terminal = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "grok", graphicalSessionEnabled: false });
    expect([windows.runtimeMode, wsl.runtimeMode, terminal.runtimeMode]).toEqual(["app-server", "app-server", undefined]);
    expect(codexAppServerSessionService.start).toHaveBeenCalledTimes(2);
    expect(mocks.spawnSync.mock.calls.some(([command, args]) => command === "wsl.exe" && args.some(value => String(value).includes("command -v grok")))).toBe(true);
  });

  it("continues launching Codex when the runtime tunnel lookup fails", async () => {
    const mocks = createMocks();
    mocks.sshHookTunnelService.ensureTunnel.mockRejectedValue(new Error("tunnel unavailable"));
    await mocks.launcher.createSession({ type: "ssh", cwd: "/srv/app", agentProvider: "codex", sshConfig: { host: "example.com" } });
    expect(mocks.terminalManager.closeSession).not.toHaveBeenCalled();
    expect(mocks.terminalManager.write).toHaveBeenCalledWith("run-1", expect.stringContaining("tunnel unavailable"));
    expect(mocks.terminalManager.write).toHaveBeenCalledWith("run-1", expect.stringContaining("cd '/srv/app' && codex;"));
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
    expect(mocks.terminalManager.write).toHaveBeenCalledWith("run-1", expect.stringContaining("PANNEL_HANDLE_SESSION_ID='run-1' codex;"));
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

  it("starts local SSH Codex through App Server with the scoped bridge", async () => {
    const binding = {
      workspacePath: "C:\\runtime\\run-1",
      developerInstructions: "Use only the remote workspace.",
      url: "http://127.0.0.1:4568/mcp",
      token: "secret-token",
      tokenEnv: "PANNEL_HANDLE_REMOTE_AGENT_TOKEN"
    };
    const remoteAgentBridgeService = {
      createBinding: vi.fn(async () => binding),
      runConfiguredCommand: vi.fn(async () => ({ exitCode: 0 })),
      closeBinding: vi.fn(async () => {})
    };
    const codexAppServerSessionService = { start: vi.fn(async () => ({})) };
    const mocks = createMocks({ remoteAgentBridgeService, codexAppServerSessionService });
    const options = { type: "ssh", cwd: "/srv/app", initialCommand: "git status --short",
      agentProvider: "codex", agentLocation: "local", graphicalSessionEnabled: true,
      sshConfig: { host: "example.com" } };
    const session = await mocks.launcher.createSession(options);
    expect(session).toMatchObject({ runtimeMode: "app-server", deferTerminalStart: true });
    expect(remoteAgentBridgeService.runConfiguredCommand).toHaveBeenCalledWith(session.id, "git status --short");
    expect(codexAppServerSessionService.start).toHaveBeenCalledWith(session, expect.objectContaining({
      localBridge: true, workspaceCwd: binding.workspacePath, shell: "powershell.exe",
      runtimeEnv: { PANNEL_HANDLE_REMOTE_AGENT_TOKEN: "secret-token" }
    }));
    const command = codexAppServerSessionService.start.mock.calls[0][1].codexCommand;
    expect(command).toContain("mcp_servers.pannel_handle_remote.url");
    expect(command).toContain("mcp_servers.pannel_handle_remote.bearer_token_env_var");
    expect(command).toContain("developer_instructions");
    expect(command).not.toContain(binding.token);
    expect(mocks.terminalManager.startDeferredSession).not.toHaveBeenCalled();
    const launched = await mocks.launcher.launchSession({ ...options, id: "saved" });
    expect(mocks.terminalManager.launchSession).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      deferTerminalStart: true, runtimeMode: "app-server"
    }));
    expect(codexAppServerSessionService.start).toHaveBeenCalledTimes(2);
  });

  it("waits for graphical trust before starting a managed local SSH Codex App Server", async () => {
    let approve;
    const codexWorkspaceTrustService = { request: vi.fn(() => new Promise(resolve => { approve = resolve; })) };
    const remoteAgentBridgeService = {
      createBinding: vi.fn(async () => ({ workspacePath: "C:\\runtime\\run-1", managedWorkspace: true, persistentWorkspace: true,
        hostTrustKey: "host-key", hostTrustLabel: "deploy@example.com:22",
        url: "http://127.0.0.1:4568/mcp", token: "secret-token", tokenEnv: "PANNEL_HANDLE_REMOTE_AGENT_TOKEN" })),
      closeBinding: vi.fn(async () => {})
    };
    const codexAppServerSessionService = { start: vi.fn(async () => ({})) };
    const mocks = createMocks({ remoteAgentBridgeService, codexAppServerSessionService, codexWorkspaceTrustService });
    const launch = mocks.launcher.createSession({ type: "ssh", cwd: "/srv/app", agentProvider: "codex",
      agentLocation: "local", graphicalSessionEnabled: true, sshConfig: { host: "example.com" } });
    await vi.waitFor(() => expect(codexWorkspaceTrustService.request).toHaveBeenCalledWith({
      sessionId: "run-1", title: undefined, workspacePath: "C:\\runtime\\run-1", persistent: true,
      hostTrustKey: "host-key", hostTrustLabel: "deploy@example.com:22"
    }));
    expect(codexAppServerSessionService.start).not.toHaveBeenCalled();
    approve();
    await launch;
    expect(codexAppServerSessionService.start).toHaveBeenCalledOnce();
  });

  it("cleans up a local bridge when its App Server fails to start", async () => {
    const remoteAgentBridgeService = {
      createBinding: vi.fn(async () => ({ workspacePath: "C:\\runtime\\run-1", url: "http://127.0.0.1:4568/mcp",
        token: "secret-token", tokenEnv: "PANNEL_HANDLE_REMOTE_AGENT_TOKEN" })),
      closeBinding: vi.fn(async () => {})
    };
    const codexAppServerSessionService = { start: vi.fn(async () => { throw new Error("App Server failed"); }) };
    const mocks = createMocks({ remoteAgentBridgeService, codexAppServerSessionService });
    await expect(mocks.launcher.createSession({ type: "ssh", cwd: "/srv/app", agentProvider: "codex",
      agentLocation: "local", graphicalSessionEnabled: true, sshConfig: { host: "example.com" } }))
      .rejects.toThrow("App Server failed");
    expect(mocks.terminalManager.closeSession).toHaveBeenCalledWith("run-1");
    expect(remoteAgentBridgeService.closeBinding).toHaveBeenCalledWith("run-1");
    expect(mocks.terminalManager.deleteSavedSession).toHaveBeenCalledWith("1");
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
    expect(runtime.runtimeInitialCommand).toContain("opencode --standalone 'C:\\runtime\\run-1'");
    expect(runtime.runtimeInitialCommand).not.toContain("secret-token");
    expect(JSON.parse(runtime.runtimeEnv.OPENCODE_CONFIG_CONTENT).mcp.servers.pannel_handle_remote.url)
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

  it("starts CodeBuddy ACP through the authenticated local SSH bridge", async () => {
    const remoteAgentBridgeService = {
      createBinding: vi.fn(async () => ({ workspacePath: "C:\\runtime\\run-1", url: "http://127.0.0.1:4568/mcp",
        token: "secret-token", tokenEnv: "PANNEL_HANDLE_REMOTE_AGENT_TOKEN", runtimeInstructions: "Use remote tools." })),
      runConfiguredCommand: vi.fn(async () => ({})), closeBinding: vi.fn(async () => {})
    };
    const codexAppServerSessionService = { start: vi.fn(async () => {}) };
    const mocks = createMocks({ remoteAgentBridgeService, codexAppServerSessionService });
    const result = await mocks.launcher.createSession({ type: "ssh", cwd: "/srv/app", agentProvider: "codebuddy",
      graphicalSessionEnabled: true, agentLocation: "local", sshConfig: { host: "example.com" } });
    expect(result.runtimeMode).toBe("app-server");
    const runtime = codexAppServerSessionService.start.mock.calls[0][1];
    expect(runtime).toMatchObject({ localBridge: true, workspaceCwd: "C:\\runtime\\run-1" });
    expect(runtime.acpArgs).toContain("--acp --mcp-config");
    expect(runtime.acpArgs).toContain("--strict-mcp-config");
    expect(runtime.acpArgs).not.toContain("--tools Read,Glob,Grep");
    expect(runtime.acpArgs).toContain("Bearer ${PANNEL_HANDLE_REMOTE_AGENT_TOKEN}");
    expect(runtime.acpArgs).not.toContain("--plugin-dir");
    expect(runtime).not.toHaveProperty("inheritance");
    expect(runtime).not.toHaveProperty("refreshInheritance");
    expect(runtime.runtimeEnv.PANNEL_HANDLE_REMOTE_AGENT_INSTRUCTIONS).toBe("Use remote tools.");
    expect(runtime.acpArgs).not.toContain("secret-token");
  });

  it("starts OpenCode ACP through the restricted local SSH bridge", async () => {
    const binding = { workspacePath: "C:\\runtime\\run-1", url: "http://127.0.0.1:4568/mcp",
      token: "secret-token", tokenEnv: "PANNEL_HANDLE_REMOTE_AGENT_TOKEN", developerInstructions: "Use remote tools." };
    const remoteAgentBridgeService = { createBinding: vi.fn(async () => binding),
      runConfiguredCommand: vi.fn(async () => ({})), closeBinding: vi.fn(async () => {}) };
    const codexAppServerSessionService = { start: vi.fn(async () => {}) };
    const mocks = createMocks({ remoteAgentBridgeService, codexAppServerSessionService });
    const result = await mocks.launcher.createSession({ type: "ssh", cwd: "/srv/app", agentProvider: "opencode",
      graphicalSessionEnabled: true, agentLocation: "local", sshConfig: { host: "example.com" } });
    expect(result.runtimeMode).toBe("app-server");
    const runtime = codexAppServerSessionService.start.mock.calls[0][1];
    expect(runtime.requiredMode).toBe("pannel-handle-remote");
    expect(runtime.runtimeEnv.PANNEL_HANDLE_REMOTE_AGENT_TOKEN).toBe("secret-token");
    expect(JSON.parse(runtime.runtimeEnv.OPENCODE_CONFIG_CONTENT).mcp.servers.pannel_handle_remote.url).toBe(binding.url);
    expect(runtime.runtimeEnv.OPENCODE_CONFIG_CONTENT).not.toContain("secret-token");
  });

  it("starts Qoder graphically on Windows, WSL and SSH remote", async () => {
    const codexAppServerSessionService = { start: vi.fn(async () => {}) };
    const mocks = createMocks({ codexAppServerSessionService });
    const windows = await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "qoder", graphicalSessionEnabled: true });
    const wsl = await mocks.launcher.createSession({ type: "wsl", wslDistro: "Ubuntu", cwd: "/srv/app", agentProvider: "qoder", graphicalSessionEnabled: true });
    const ssh = await mocks.launcher.createSession({ type: "ssh", cwd: "/srv/app", agentProvider: "qoder", graphicalSessionEnabled: true,
      agentLocation: "remote", sshConfig: { host: "example.com" } });
    expect([windows.runtimeMode, wsl.runtimeMode, ssh.runtimeMode]).toEqual(["app-server", "app-server", "app-server"]);
    expect(codexAppServerSessionService.start).toHaveBeenCalledTimes(3);
  });

  it("starts Qoder with the restricted local SSH bridge and rejects its terminal mode", async () => {
    const binding = { workspacePath: "C:\\runtime\\run-1", url: "http://127.0.0.1:4568/mcp",
      token: "secret-token", tokenEnv: "PANNEL_HANDLE_REMOTE_AGENT_TOKEN", runtimeInstructions: "Use remote tools." };
    const remoteAgentBridgeService = { createBinding: vi.fn(async () => binding),
      runConfiguredCommand: vi.fn(async () => ({})), closeBinding: vi.fn(async () => {}) };
    const codexAppServerSessionService = { start: vi.fn(async () => {}) };
    const mocks = createMocks({ remoteAgentBridgeService, codexAppServerSessionService });
    const request = { type: "ssh", cwd: "/srv/app", agentProvider: "qoder", agentLocation: "local",
      sshConfig: { host: "example.com" } };
    await expect(mocks.launcher.createSession({ ...request, graphicalSessionEnabled: false })).rejects.toThrow("仅支持图形会话");
    const session = await mocks.launcher.createSession({ ...request, graphicalSessionEnabled: true });
    expect(session.runtimeMode).toBe("app-server");
    expect(codexAppServerSessionService.start).toHaveBeenCalledWith(session, expect.objectContaining({
      remoteBridge: { url: binding.url, token: binding.token, instructions: binding.runtimeInstructions },
      workspaceCwd: binding.workspacePath
    }));
    expect(mocks.hookConfigManager.install).not.toHaveBeenCalled();
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

  it("shows the Claude ACP install command when a graphical Agent switch cannot find it", async () => {
    const mocks = createMocks({ codexAppServerSessionService: { start: vi.fn(async () => {}) } });
    await mocks.launcher.createSession({ type: "windows", cwd: "C:\\work", agentProvider: "codex", graphicalSessionEnabled: true });
    mocks.spawnSync.mockImplementation((command, args) => ({
      status: command === "where.exe" && args[0] === "claude-agent-acp" ? 1 : 0,
      stdout: ""
    }));

    await expect(mocks.launcher.switchAgent("run-1", "claude"))
      .rejects.toThrow("npm install -g @agentclientprotocol/claude-agent-acp");
    expect(mocks.terminalManager.closeSession).not.toHaveBeenCalled();
  });

  it("switches only the running Codex session to a selected backend model", async () => {
    const openRouterService = {
      getConfig: vi.fn(() => ({ defaultModelId: "openai/gpt-5.4" })),
      getLaunchConfig: vi.fn(async session => session.codexBackend === "openrouter" ? {
        apiKey: "secret",
        apiKeyEnv: "OPENROUTER_API_KEY",
        providerId: "openrouter",
        providerName: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: session.codexModel,
        catalogPath: "C:\\catalog.json"
      } : null)
    };
    const naraRouterService = { getConfig: vi.fn(), getLaunchConfig: vi.fn(async () => null) };
    const codeBuddyCodexBridgeService = { getConfig: vi.fn(), getLaunchConfig: vi.fn(async () => null) };
    const mocks = createMocks({ openRouterService, naraRouterService, codeBuddyCodexBridgeService });
    mocks.sessions.push({
      id: "run-1",
      templateId: "template-1",
      title: "Codex",
      shell: "cmd.exe",
      cwd: "C:\\work",
      type: "windows",
      agentProvider: "codex",
      codexBackend: "openai"
    });

    const result = await mocks.launcher.switchModelSource("run-1", "openrouter", true, "openai/gpt-5.4");

    expect(mocks.terminalManager.closeSession).toHaveBeenCalledWith("run-1");
    expect(mocks.terminalManager.launchSession).toHaveBeenCalledWith(expect.objectContaining({
      codexBackend: "openrouter",
      codexModel: "openai/gpt-5.4",
      codexExperimentalAcknowledged: undefined
    }), expect.objectContaining({
      useProvidedTemplate: true,
      templateId: "template-1",
      runtimeInitialCommand: expect.stringContaining("openai/gpt-5.4")
    }));
    expect(mocks.sessionStore.updateLibrary).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: "run-1", codexBackend: "openrouter", codexModel: "openai/gpt-5.4" });
  });

  it("keeps the current Codex session when no target model is selected", async () => {
    const openRouterService = {
      getConfig: vi.fn(() => ({ defaultModelId: "" })),
      getLaunchConfig: vi.fn(async () => null)
    };
    const mocks = createMocks({ openRouterService });
    mocks.sessions.push({
      id: "run-1",
      templateId: "template-1",
      title: "Codex",
      shell: "cmd.exe",
      cwd: "C:\\work",
      type: "windows",
      agentProvider: "codex",
      codexBackend: "openai"
    });

    await expect(mocks.launcher.switchModelSource("run-1", "openrouter")).rejects.toThrow("请选择 OpenRouter 模型");

    expect(mocks.terminalManager.closeSession).not.toHaveBeenCalled();
    expect(mocks.terminalManager.launchSession).not.toHaveBeenCalled();
    expect(mocks.sessions).toEqual([expect.objectContaining({ id: "run-1", codexBackend: "openai" })]);
  });
  it("rebuilds a Codex graphical session when selecting another verified model on the same backend", async () => {
    const openRouterService = {
      getConfig: vi.fn(() => ({ defaultModelId: "vendor/default" })),
      getLaunchConfig: vi.fn(async session => ({ apiKey: "secret", apiKeyEnv: "OPENROUTER_API_KEY",
        providerId: "openrouter", providerName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1",
        model: session.codexModel, catalogPath: "C:\\catalog.json" }))
    };
    const mocks = createMocks({ openRouterService, codexAppServerSessionService: { start: vi.fn(async () => {}) } });
    mocks.sessions.push({ id: "run-1", templateId: "template-1", title: "Codex", shell: "cmd.exe",
      cwd: "C:\\work", type: "windows", agentProvider: "codex", graphicalSessionEnabled: true,
      runtimeMode: "app-server", codexBackend: "openrouter", codexModel: "vendor/current" });
    const result = await mocks.launcher.switchModelSource("run-1", "openrouter", true, "vendor/next");
    expect(result).toMatchObject({ codexBackend: "openrouter", codexModel: "vendor/next", runtimeMode: "app-server" });
    expect(openRouterService.getLaunchConfig).toHaveBeenCalledWith(expect.objectContaining({ codexModel: "vendor/next" }));
    expect(mocks.terminalManager.closeSession).toHaveBeenCalledWith("run-1");
  });

  it("rejects Codex backend switching for SSH and non-Codex sessions", async () => {
    const mocks = createMocks();
    mocks.sessions.push({ id: "run-1", type: "ssh", cwd: "/work", agentProvider: "codex", codexBackend: "openai" });
    mocks.sessions.push({ id: "run-2", type: "windows", cwd: "C:\\work", agentProvider: "claude" });

    await expect(mocks.launcher.switchModelSource("run-1", "openrouter")).rejects.toThrow("Windows 和 WSL");
    await expect(mocks.launcher.switchModelSource("run-2", "openrouter")).rejects.toThrow("该会话不支持模型来源切换");
    expect(mocks.terminalManager.closeSession).not.toHaveBeenCalled();
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
