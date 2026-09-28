import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  AGENT_EXIT_MARKER,
  buildSshArgs,
  createTerminalManager,
  getDefaultShell,
  resolveRunnableExecutable
} = require("./terminal-manager.cjs");

function createMockTerm() {
  const dataHandlers = [];
  const exitHandlers = [];
  const statusHandlers = [];

  return {
    writes: [],
    resizes: [],
    killed: false,
    onData(callback) {
      dataHandlers.push(callback);
      return {
        dispose() {
          const index = dataHandlers.indexOf(callback);
          if (index >= 0) dataHandlers.splice(index, 1);
        }
      };
    },
    onExit(callback) {
      exitHandlers.push(callback);
      return {
        dispose() {
          const index = exitHandlers.indexOf(callback);
          if (index >= 0) exitHandlers.splice(index, 1);
        }
      };
    },
    emitData(data) {
      for (const callback of [...dataHandlers]) callback(data);
    },
    emitExit(exitCode, details = {}) {
      for (const callback of [...exitHandlers]) callback({ exitCode, ...details });
    },
    onStatus(callback) {
      statusHandlers.push(callback);
      return { dispose() {} };
    },
    emitStatus(status) {
      for (const callback of [...statusHandlers]) callback({ status });
    },
    write(data) {
      this.writes.push(data);
    },
    resize(cols, rows) {
      this.resizes.push([cols, rows]);
    },
    kill() {
      this.killed = true;
    }
  };
}

function createConfigStoreMock() {
  let lastActiveSessionIds = [];
  return {
    getConfig: vi.fn(() => ({ lastActiveSessionIds: [...lastActiveSessionIds] })),
    updateConfig: vi.fn((updates) => {
      lastActiveSessionIds = [...updates.lastActiveSessionIds];
    })
  };
}

function createManager(overrides = {}) {
  const term = createMockTerm();
  const pty = { spawn: vi.fn(() => term) };
  const ssh2TerminalFactory = vi.fn(() => term);
  const broadcast = vi.fn();
  const templates = new Map();
  const sessionStore = {
    createTemplateId: vi.fn(() => "1"),
    normalizeTemplate: vi.fn((template) => ({
      id: template.id,
      title: template.title,
      shell: template.shell || "powershell.exe",
      cwd: template.cwd || (template.type === "wsl" || template.type === "ssh" ? "~" : "C:\\Users\\tester"),
      preferredDiskMountPoint: template.preferredDiskMountPoint,
      createdAt: template.createdAt || 111,
      initialCommand: template.initialCommand,
      agentProvider: template.agentProvider,
      agentLocation: template.agentLocation,
      modelSource: template.modelSource,
      modelId: template.modelId,
      codexBackend: template.codexBackend,
      codexModel: template.codexModel,
      codexExperimentalAcknowledged: template.codexExperimentalAcknowledged,
      graphicalSessionEnabled: template.graphicalSessionEnabled,
      type: template.type || "windows",
      wslDistro: template.wslDistro,
      sshConfig: template.sshConfig,
      quickCommands: template.quickCommands || [],
      tags: template.tags || []
    })),
    addToLibrary: vi.fn((template) => templates.set(template.id, template)),
    removeFromLibrary: vi.fn(),
    updateLibrary: vi.fn((id, updates) => {
      templates.set(id, { ...(templates.get(id) || { id }), ...updates });
    }),
    getTemplate: vi.fn((id) => templates.get(id)),
    decryptSecret: vi.fn((encryptedSecret) => encryptedSecret === "ciphertext" ? "plain-secret" : undefined)
  };
  const manager = createTerminalManager({
    sessionStore,
    broadcast,
    getHookUrl: () => "http://127.0.0.1:4567",
    pty,
    ssh2TerminalFactory,
    ...overrides
  });

  return { manager, term, pty, ssh2TerminalFactory, broadcast, sessionStore };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("terminal-manager", () => {
  it("runs session closing cleanup while the session is still addressable", () => {
    let manager;
    const onSessionClosing = vi.fn(id => expect(manager.getSession(id)).toBeDefined());
    ({ manager } = createManager({ onSessionClosing }));
    const session = manager.createSession({ cwd: "C:\\Users\\tester", persist: false });
    manager.closeSession(session.id);
    expect(onSessionClosing).toHaveBeenCalledWith(session.id);
  });
  it("uses PowerShell 7 when selected and runnable", () => {
    const resolveExecutable = vi.fn(() => "C:\\Program Files\\PowerShell\\7\\pwsh.exe");

    expect(getDefaultShell({ platform: "win32", preference: "pwsh", resolveExecutable }))
      .toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(resolveExecutable).toHaveBeenCalledWith("pwsh.exe");
  });

  it("defaults to CMD without probing PowerShell", () => {
    const resolveExecutable = vi.fn();
    expect(getDefaultShell({ platform: "win32", env: {}, resolveExecutable }))
      .toBe("C:\\Windows\\System32\\cmd.exe");
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it("resolves Windows PowerShell and respects system locations", () => {
    expect(getDefaultShell({ platform: "win32", preference: "powershell", env: { SystemRoot: "D:\\Windows" } }))
      .toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(getDefaultShell({ platform: "win32", env: { ComSpec: "D:\\Windows\\System32\\cmd.exe" } }))
      .toBe("D:\\Windows\\System32\\cmd.exe");
  });

  it("can resolve saved metadata without requiring PowerShell 7 to be installed", () => {
    const resolveExecutable = vi.fn(() => null);
    expect(getDefaultShell({ platform: "win32", preference: "pwsh", requireAvailable: false, resolveExecutable })).toBe("pwsh.exe");
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it("reports an unavailable selected PowerShell 7 without fallback", () => {
    expect(() => getDefaultShell({ platform: "win32", preference: "pwsh", resolveExecutable: () => null }))
      .toThrow("PowerShell 7 不可用");
  });

  it("reads updated defaults for new sessions and preserves explicit shells", () => {
    let preference = "cmd";
    const getConfiguredShell = vi.fn((selected) => getDefaultShell({
      platform: "win32", env: {}, preference: selected || preference,
      resolveExecutable: () => "C:\\PowerShell\\pwsh.exe"
    }));
    const { manager, sessionStore } = createManager({ getDefaultShell: getConfiguredShell });
    let nextId = 0;
    sessionStore.createTemplateId.mockImplementation(() => String(++nextId));
    const first = manager.createSession();
    expect(first.shell).toBe("C:\\Windows\\System32\\cmd.exe");
    preference = "pwsh";
    expect(manager.createSession().shell).toBe("C:\\PowerShell\\pwsh.exe");
    expect(first.shell).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(manager.createSession({ windowsShell: "powershell" }).shell).toContain("WindowsPowerShell");
    expect(manager.createSession({ shell: "custom-shell.exe" }).shell).toBe("custom-shell.exe");
    expect(sessionStore.addToLibrary).toHaveBeenCalledWith(expect.objectContaining({ shell: "custom-shell.exe" }));
  });

  it("skips an unusable pwsh alias and returns the next runnable candidate", () => {
    const execFile = vi.fn((executable) => {
      if (executable === "where.exe") {
        return [
          "C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe",
          "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
        ].join("\r\n");
      }
      if (executable.includes("WindowsApps")) {
        throw Object.assign(new Error("Access denied"), { code: "EACCES" });
      }
      return "";
    });

    expect(resolveRunnableExecutable("pwsh.exe", execFile))
      .toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(execFile).toHaveBeenCalledWith(
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
      expect.objectContaining({ timeout: 3000 })
    );
  });

  it("returns null when every resolved pwsh candidate fails to start", () => {
    const execFile = vi.fn((executable) => {
      if (executable === "where.exe") return "C:\\WindowsApps\\pwsh.exe\r\n";
      throw Object.assign(new Error("Access denied"), { code: "EACCES" });
    });

    expect(resolveRunnableExecutable("pwsh.exe", execFile)).toBeNull();
  });

  it("spawns PowerShell 7 for a Windows session without an explicit shell", () => {
    const { manager, pty } = createManager({ getDefaultShell: () => "pwsh.exe" });

    const session = manager.createSession({ title: "Main" });

    expect(session.shell).toBe("pwsh.exe");
    expect(pty.spawn).toHaveBeenCalledWith("pwsh.exe", [], expect.any(Object));
  });

  it("creates a session, persists its template, and spawns a PTY", () => {
    vi.spyOn(Date, "now").mockReturnValue(222);
    const { manager, pty, broadcast, sessionStore } = createManager();

    const session = manager.createSession({
      title: "Main",
      shell: "pwsh.exe",
      cwd: "C:\\work",
      cols: 120,
      rows: 40
    });

    expect(session).toMatchObject({
      id: "run-1",
      templateId: "1",
      title: "Main",
      shell: "pwsh.exe",
      cwd: "C:\\work",
      createdAt: 222,
      type: "windows"
    });
    expect(sessionStore.addToLibrary).toHaveBeenCalledWith(expect.objectContaining({
      id: "1",
      title: "Main"
    }));
    expect(pty.spawn).toHaveBeenCalledWith("pwsh.exe", [], expect.objectContaining({
      cols: 120,
      rows: 40,
      cwd: "C:\\work",
      env: expect.objectContaining({
        PANNEL_HANDLE_SESSION_ID: "run-1",
        PANNEL_HANDLE_HOOK_URL: "http://127.0.0.1:4567"
      })
    }));
    expect(broadcast).toHaveBeenCalledWith("sessions:changed", [session]);
  });

  it("persists experimental OpenRouter acknowledgement and clears it when the model changes", () => {
    const { manager, sessionStore } = createManager();
    const session = manager.createSession({
      title: "Experimental",
      agentProvider: "codex",
      codexBackend: "openrouter",
      codexModel: "vendor/partial-a",
      codexExperimentalAcknowledged: true
    });

    expect(session).toMatchObject({ codexModel: "vendor/partial-a", codexExperimentalAcknowledged: true });
    manager.updateSession(session.id, { codexModel: "vendor/partial-b" });
    expect(manager.getSession(session.id).codexExperimentalAcknowledged).toBeUndefined();
    expect(sessionStore.updateLibrary).toHaveBeenCalledWith("1", expect.objectContaining({
      codexModel: "vendor/partial-b",
      codexExperimentalAcknowledged: null
    }));
  });

  it("persists NaraRouter selection and clears its acknowledgement when the model changes", () => {
    const { manager } = createManager();
    const session = manager.createSession({
      title: "NaraRouter",
      agentProvider: "codex",
      codexBackend: "nararouter",
      codexModel: "partial-a",
      codexExperimentalAcknowledged: true
    });
    expect(session).toMatchObject({ codexBackend: "nararouter", codexModel: "partial-a", codexExperimentalAcknowledged: true });
    manager.updateSession(session.id, { codexModel: "partial-b" });
    expect(manager.getSession(session.id).codexExperimentalAcknowledged).toBeUndefined();
  });

  it("clears CodeBuddy Codex acknowledgement when the model changes", () => {
    const { manager } = createManager();
    const session = manager.createSession({
      title: "CodeBuddy Codex",
      agentProvider: "codex",
      codexBackend: "codebuddy",
      codexModel: "glm-5.2",
      codexExperimentalAcknowledged: true
    });

    expect(session.codexExperimentalAcknowledged).toBe(true);
    manager.updateSession(session.id, { codexModel: "kimi-k2.5" });
    expect(manager.getSession(session.id).codexExperimentalAcknowledged).toBeUndefined();
  });

  it("creates a transient session without persisting or restoring it", () => {
    const configStore = createConfigStoreMock();
    const { manager, sessionStore } = createManager({ configStore });

    const session = manager.createSession({
      title: "Codex 路 work",
      cwd: "C:\\work",
      agentProvider: "codex",
      persist: false
    });

    expect(session).toMatchObject({
      id: "run-1",
      title: "Codex 路 work",
      cwd: "C:\\work",
      agentProvider: "codex"
    });
    expect(session.templateId).toBeUndefined();
    expect(sessionStore.addToLibrary).not.toHaveBeenCalled();
    expect(configStore.updateConfig).not.toHaveBeenCalled();

    const secondSession = manager.createSession({
      title: "Codex 路 work",
      cwd: "C:\\work",
      agentProvider: "codex",
      persist: false
    });
    expect(secondSession.title).toBe("Codex 路 work #2");
    expect(secondSession.templateId).toBeUndefined();

    manager.renameSession(session.id, "Temporary Agent");
    manager.updateSession(session.id, { cwd: "C:\\next" });
    expect(sessionStore.updateLibrary).not.toHaveBeenCalled();

    manager.closeSession(session.id);
    manager.closeSession(secondSession.id);
    expect(manager.listSessions()).toEqual([]);
    expect(configStore.getConfig().lastActiveSessionIds).toEqual([]);
  });

  it("persists and synchronizes the preferred SSH disk across template instances", () => {
    const { manager, sessionStore } = createManager();
    const first = manager.createSession({
      title: "Server",
      type: "ssh",
      sshConfig: { host: "example.com" }
    });
    manager.launchSessions([{ id: first.templateId, title: "Server", type: "ssh", sshConfig: { host: "example.com" } }]);

    manager.updateSession(first.id, { preferredDiskMountPoint: "/data" });

    expect(manager.listSessions()).toHaveLength(2);
    expect(manager.listSessions().every((session) => session.preferredDiskMountPoint === "/data")).toBe(true);
    expect(sessionStore.updateLibrary).toHaveBeenCalledWith(first.templateId, { preferredDiskMountPoint: "/data" });
  });

  it("rolls back the runtime session when PTY startup fails", () => {
    const spawnError = new Error("spawn failed");
    const { manager, sessionStore } = createManager({
      pty: { spawn: vi.fn(() => { throw spawnError; }) }
    });

    expect(() => manager.createSession({ title: "Broken" })).toThrow(spawnError);

    expect(manager.listSessions()).toEqual([]);
    expect(sessionStore.addToLibrary).not.toHaveBeenCalled();
  });

  it("rejects invalid terminal instances without leaving an unclosable session", () => {
    const { manager } = createManager({
      pty: { spawn: vi.fn(() => undefined) }
    });

    expect(() => manager.createSession({ title: "Broken" })).toThrow("invalid terminal instance");
    expect(manager.listSessions()).toEqual([]);
  });

  it("broadcasts terminal data, stores bounded history, and sends an initial command after first output", () => {
    const { manager, term, broadcast } = createManager();

    const session = manager.createSession({ title: "Main", initialCommand: " pnpm dev " });
    term.emitData("ready");

    expect(manager.getHistory(session.id)).toBe("ready");
    expect(term.writes).toEqual(["pnpm dev\r"]);
    expect(broadcast).toHaveBeenCalledWith("terminal:data", { id: session.id, data: "ready" });

    for (let index = 0; index < 1005; index += 1) {
      term.emitData(String(index % 10));
    }

    expect(manager.getSession(session.id).buffer).toHaveLength(1000);
  });

  it("renames, updates, writes, resizes, and closes active sessions", () => {
    const { manager, term, sessionStore, broadcast } = createManager();
    const session = manager.createSession({ title: "Main" });

    manager.renameSession(session.id, "  Renamed  ");
    manager.updateSession(session.id, { initialCommand: "npm test" });
    manager.write(session.id, "abc");
    manager.resize(session.id, 90, 24);
    const remaining = manager.closeSession(session.id);

    expect(sessionStore.updateLibrary).toHaveBeenCalledWith("1", { title: "Renamed" });
    expect(sessionStore.updateLibrary).toHaveBeenCalledWith("1", { initialCommand: "npm test" });
    expect(term.writes).toEqual(["abc"]);
    expect(term.resizes).toEqual([[90, 24]]);
    expect(term.killed).toBe(true);
    expect(remaining).toEqual([]);
    expect(broadcast).toHaveBeenLastCalledWith("sessions:changed", []);
  });

  it("clears a Codex session when the submitted terminal command is /clear", () => {
    vi.spyOn(Date, "now").mockReturnValue(555);
    const onAgentStatusChanged = vi.fn();
    const { manager, term, broadcast } = createManager({ onAgentStatusChanged });
    const session = manager.createSession({ title: "Codex", agentProvider: "codex" });
    manager.getSession(session.id).agentStatus = "completed";

    manager.write(session.id, "/");
    manager.write(session.id, "clear");
    manager.write(session.id, "\r");

    expect(term.writes).toEqual(["/", "clear", "\r"]);
    expect(manager.getSession(session.id).agentStatus).toBe("cleared");
    expect(broadcast).toHaveBeenCalledWith("agent:status", {
      provider: "codex",
      timestamp: 555,
      id: session.id,
      status: "cleared",
      eventName: "TerminalCommand"
    });
    expect(onAgentStatusChanged).toHaveBeenCalledWith(expect.objectContaining({
      id: session.id,
      provider: "codex",
      status: "cleared"
    }));
  });

  it("clears a Codex session when Enter submits /clear with a line feed", () => {
    const { manager, broadcast } = createManager();
    const session = manager.createSession({ title: "Codex", agentProvider: "codex" });
    manager.getSession(session.id).agentStatus = "completed";

    manager.write(session.id, "/clear\n\r");

    expect(manager.getSession(session.id).agentStatus).toBe("cleared");
    const clearEvents = broadcast.mock.calls.filter(([channel, payload]) => (
      channel === "agent:status" && payload.status === "cleared"
    ));
    expect(clearEvents).toEqual([["agent:status", expect.objectContaining({
      id: session.id,
      provider: "codex",
      status: "cleared",
      eventName: "TerminalCommand"
    })]]);
  });

  it("keeps terminal clear detection after the configured provider is edited", () => {
    const { manager, broadcast } = createManager();
    const session = manager.createSession({ title: "Codex", agentProvider: "codex" });
    manager.getSession(session.id).agentStatus = "completed";
    manager.updateSession(session.id, { agentProvider: null });

    manager.write(session.id, "/clear\r");

    expect(manager.getSession(session.id).agentStatus).toBe("cleared");
    expect(broadcast).toHaveBeenCalledWith("agent:status", expect.objectContaining({
      id: session.id,
      provider: "codex",
      status: "cleared"
    }));
  });

  it("recognizes /clear after common terminal line editing", () => {
    const { manager, broadcast } = createManager();
    const session = manager.createSession({ title: "Codex", agentProvider: "codex" });

    manager.write(session.id, "  /cleax");
    manager.write(session.id, "\x7fr  \r");
    manager.write(session.id, "discarded\x15 /clear \r");

    const clearEvents = broadcast.mock.calls.filter(([channel, payload]) => (
      channel === "agent:status" && payload.status === "cleared"
    ));
    expect(clearEvents).toHaveLength(2);
  });

  it("recognizes /clear selected by Codex tab completion", () => {
    const { manager, broadcast } = createManager();
    const session = manager.createSession({ title: "Codex", agentProvider: "codex" });

    manager.write(session.id, "/cl");
    manager.write(session.id, "\t");
    manager.write(session.id, "\r");

    expect(broadcast).toHaveBeenCalledWith("agent:status", expect.objectContaining({
      id: session.id,
      provider: "codex",
      status: "cleared"
    }));
  });

  it("recognizes /clear through terminal control sequences", () => {
    const { manager, broadcast } = createManager();
    const session = manager.createSession({ title: "Codex", agentProvider: "codex" });

    manager.write(session.id, "\x1b[A");
    manager.write(session.id, "\x1b[20");
    manager.write(session.id, "0~/clear");
    manager.write(session.id, "\x1b[201~\r");

    expect(broadcast).toHaveBeenCalledWith("agent:status", expect.objectContaining({
      id: session.id,
      provider: "codex",
      status: "cleared"
    }));
  });

  it("recognizes /clear after a standalone Escape key", () => {
    const { manager, broadcast } = createManager();
    const session = manager.createSession({ title: "Codex", agentProvider: "codex" });

    manager.write(session.id, "\x1b");
    manager.write(session.id, "/clear\r");

    expect(broadcast).toHaveBeenCalledWith("agent:status", expect.objectContaining({
      id: session.id,
      provider: "codex",
      status: "cleared"
    }));
  });

  it("does not clear status for unsubmitted, similar, or non-Codex commands", () => {
    const { manager, broadcast } = createManager();
    const codexSession = manager.createSession({ title: "Codex", agentProvider: "codex" });
    const claudeSession = manager.createSession({ title: "Claude", agentProvider: "claude" });
    manager.updateSession(claudeSession.id, { agentProvider: "claude" });

    manager.write(codexSession.id, "/clear");
    manager.write(codexSession.id, "x\r");
    manager.write(codexSession.id, "/clear-all\r");
    manager.write(codexSession.id, "/c\t\r");
    manager.write(claudeSession.id, "/clear\r");

    expect(broadcast.mock.calls.filter(([channel, payload]) => (
      channel === "agent:status" && payload.status === "cleared"
    ))).toEqual([]);
  });

  it("can close a legacy runtime session that has no terminal instance", () => {
    const { manager, broadcast } = createManager();
    const session = manager.createSession({ title: "Broken" });
    manager.getSession(session.id).term = undefined;

    expect(() => manager.write(session.id, "abc")).not.toThrow();
    expect(() => manager.resize(session.id, 90, 24)).not.toThrow();
    expect(manager.closeSession(session.id)).toEqual([]);
    expect(broadcast).toHaveBeenLastCalledWith("sessions:changed", []);
  });

  it("persists Agent changes and explicitly clears the saved provider", () => {
    const { manager, sessionStore } = createManager();
    const session = manager.createSession({ title: "Agent", agentProvider: "claude" });

    manager.updateSession(session.id, { agentProvider: "codex" });
    expect(manager.getSession(session.id).agentProvider).toBe("codex");
    expect(sessionStore.updateLibrary).toHaveBeenLastCalledWith("1", expect.objectContaining({ agentProvider: "codex", modelSource: "native" }));

    manager.updateSession(session.id, { agentProvider: null });
    expect(manager.getSession(session.id).agentProvider).toBeUndefined();
    expect(sessionStore.updateLibrary).toHaveBeenLastCalledWith("1", expect.objectContaining({ agentProvider: null, modelSource: null }));
  });

  it("launches a runtime replacement with the original template link without changing the saved Agent", () => {
    const { manager, sessionStore, term } = createManager();
    const session = manager.createSession({ title: "Agent", cwd: "C:\\work", agentProvider: "codex" });

    manager.closeSession(session.id);
    sessionStore.updateLibrary.mockClear();
    const replacement = manager.launchSession({
      ...session,
      id: session.templateId,
      agentProvider: "claude"
    }, {
      useProvidedTemplate: true,
      templateId: session.templateId,
      runtimeInitialCommand: "claude"
    });

    expect(replacement).toMatchObject({
      templateId: session.templateId,
      agentProvider: "claude"
    });
    expect(replacement.id).not.toBe(session.id);
    term.emitData("PS C:\\work> ");
    expect(term.writes.at(-1)).toBe("claude\r");
    expect(sessionStore.getTemplate(session.templateId).agentProvider).toBe("codex");
    expect(sessionStore.updateLibrary).not.toHaveBeenCalled();
  });

  it("detects a split Agent exit marker without exposing it in terminal history", () => {
    const { manager, term, broadcast } = createManager();
    const session = manager.createSession({ title: "Agent", agentProvider: "codex" });
    term.emitData("ready");

    term.emitData(`done\r\n${AGENT_EXIT_MARKER.slice(0, 12)}`);
    term.emitData(`${AGENT_EXIT_MARKER.slice(12)}\r\n`);

    expect(manager.getHistory(session.id)).not.toContain(AGENT_EXIT_MARKER);
    expect(broadcast).toHaveBeenCalledWith("agent:status", expect.objectContaining({
      id: session.id,
      provider: "codex",
      status: "ended"
    }));
  });

  it("ignores an Agent exit marker embedded in an echoed launch command", () => {
    const { manager, term, broadcast } = createManager();
    const session = manager.createSession({ title: "Codex", agentProvider: "codex" });

    term.emitData(`PS C:\\work> & { codex }; Write-Output '${AGENT_EXIT_MARKER}'\r\n`);

    expect(broadcast).not.toHaveBeenCalledWith("agent:status", expect.objectContaining({
      id: session.id,
      status: "ended"
    }));
    expect(manager.getHistory(session.id)).toContain(AGENT_EXIT_MARKER);
  });

  it("uses a generated runtime command without replacing the saved Agent pre-command", () => {
    const { manager, term, sessionStore } = createManager();

    const session = manager.createSession({
      title: "Claude",
      cwd: "C:\\work",
      initialCommand: "pnpm install",
      agentProvider: "claude",
      runtimeInitialCommand: "pnpm install && claude"
    });
    term.emitData("ready");

    expect(session).toMatchObject({ initialCommand: "pnpm install", agentProvider: "claude" });
    expect(term.writes).toEqual(["pnpm install && claude\r"]);
    expect(sessionStore.addToLibrary).toHaveBeenCalledWith(expect.objectContaining({
      initialCommand: "pnpm install",
      agentProvider: "claude"
    }));
  });

  it("ignores invalid resize dimensions", () => {
    const { manager, term } = createManager();
    const session = manager.createSession({ title: "Main" });

    expect(() => manager.resize(session.id, 0, 24)).not.toThrow();
    expect(() => manager.resize(session.id, 90, 0)).not.toThrow();
    expect(() => manager.resize(session.id, Number.NaN, 24)).not.toThrow();

    expect(term.resizes).toEqual([]);
  });

  it("removes sessions and broadcasts agent status on PTY exit", () => {
    vi.spyOn(Date, "now").mockReturnValue(333);
    const { manager, term, broadcast } = createManager();
    const session = manager.createSession({ title: "Main" });

    term.emitExit(7);

    expect(manager.listSessions()).toEqual([]);
    expect(broadcast).toHaveBeenCalledWith("terminal:exit", { id: session.id, exitCode: 7 });
    expect(broadcast).toHaveBeenCalledWith("agent:status", expect.objectContaining({
      id: session.id,
      provider: "claude",
      status: "exited",
      eventName: "PtyExit",
      timestamp: 333,
      message: "Exit code 7"
    }));
    expect(broadcast).toHaveBeenLastCalledWith("sessions:changed", []);
  });

  it("keeps OpenCode model selection when unrelated session details change", () => {
    const { manager } = createManager();
    const session = manager.createSession({ title: "OpenCode", agentProvider: "opencode", modelSource: "openrouter", modelId: "vendor/coder" });
    manager.updateSession(session.id, { title: "Renamed", quickCommands: [{ id: "one", command: "pwd", mode: "auto-enter" }] });
    expect(manager.getSession(session.id)).toMatchObject({ modelSource: "openrouter", modelId: "vendor/coder" });
  });

  it("keeps one graphical mode when the template changes Agent providers", () => {
    expect(createManager().manager.createSession({ title: "New", agentProvider: "codebuddy" }).graphicalSessionEnabled).toBe(true);
    const { manager, sessionStore } = createManager();
    const session = manager.createSession({ title: "Agent", agentProvider: "codex", graphicalSessionEnabled: false });
    expect(session.graphicalSessionEnabled).toBe(false);
    manager.updateSession(session.id, { agentProvider: "codebuddy", graphicalSessionEnabled: false });
    expect(manager.getSession(session.id).graphicalSessionEnabled).toBe(false);
    expect(sessionStore.getTemplate("1").graphicalSessionEnabled).toBe(false);
    manager.updateSession(session.id, { agentProvider: "opencode", graphicalSessionEnabled: true });
    expect(manager.getSession(session.id).graphicalSessionEnabled).toBe(true);
    expect(sessionStore.getTemplate("1").graphicalSessionEnabled).toBe(true);
  });

  it("keeps an SSH instance in place and schedules reconnect after a transport failure", () => {
    const scheduled = [];
    const onSessionClosed = vi.fn();
    const { manager, term, ssh2TerminalFactory } = createManager({
      onSessionClosed,
      sshReconnectDelaysMs: [2000, 5000],
      setTimeoutFn: (callback, delay) => {
        const timer = { callback, delay };
        scheduled.push(timer);
        return timer;
      },
      clearTimeoutFn: vi.fn()
    });
    const session = manager.createSession({ type: "ssh", sshConfig: { host: "example.com" } });

    term.emitStatus("connected");
    term.emitExit(1, { reason: "connection-error", retryable: true, message: "socket closed" });

    expect(manager.listSessions()).toEqual([expect.objectContaining({
      id: session.id,
      sshConnectionState: "reconnecting",
      sshReconnectAttempt: 1
    })]);
    expect(scheduled).toEqual([expect.objectContaining({ delay: 2000 })]);
    expect(onSessionClosed).not.toHaveBeenCalled();

    scheduled[0].callback();
    expect(ssh2TerminalFactory).toHaveBeenCalledTimes(2);
    expect(manager.listSessions()[0].id).toBe(session.id);
    term.emitStatus("connected");
    expect(manager.listSessions()[0]).toMatchObject({
      id: session.id,
      sshConnectionState: "connected",
      sshReconnectAttempt: 0
    });
    expect(manager.getHistory(session.id)).toContain("SSH reconnected");
  });

  it("manually reconnects a retained SSH instance without changing its runtime id", () => {
    const { manager, term, ssh2TerminalFactory } = createManager({
      setTimeoutFn: () => ({ id: "timer" }),
      clearTimeoutFn: vi.fn()
    });
    const session = manager.createSession({ type: "ssh", sshConfig: { host: "example.com" } });
    term.emitExit(1, { reason: "connection-error", retryable: true });

    const reconnected = manager.reconnectSession(session.id);

    expect(reconnected).toMatchObject({ id: session.id, sshConnectionState: "reconnecting" });
    expect(ssh2TerminalFactory).toHaveBeenCalledTimes(2);
  });
  it("tracks an SSH App Server connection without starting a terminal", () => {
    const { manager, ssh2TerminalFactory } = createManager();
    const session = manager.createSession({ type: "ssh", sshConfig: { host: "example.com" },
      cwd: "/srv/app", agentProvider: "codex", agentLocation: "remote",
      runtimeMode: "app-server", deferTerminalStart: true });
    manager.setAppServerConnectionState(session.id, "connected");
    expect(manager.listSessions()[0]).toMatchObject({ sshConnectionState: "connected", sshReconnectAttempt: 0 });
    manager.setAppServerConnectionState(session.id, "reconnecting");
    expect(manager.listSessions()[0]).toMatchObject({ sshConnectionState: "reconnecting", sshReconnectAttempt: 1 });
    manager.setAppServerConnectionState(session.id, "disconnected");
    expect(manager.listSessions()[0]).toMatchObject({ sshConnectionState: "disconnected", sshReconnectAttempt: 0 });
    expect(ssh2TerminalFactory).not.toHaveBeenCalled();
  });

  it("still removes an SSH instance after a normal remote exit", () => {
    const { manager, term } = createManager();
    const session = manager.createSession({ type: "ssh", sshConfig: { host: "example.com" } });
    term.emitStatus("connected");

    term.emitExit(0, { reason: "remote-exit", retryable: false });

    expect(manager.listSessions()).toEqual([]);
    expect(manager.getSession(session.id)).toBeUndefined();
  });

  it("retains a previously connected SSH instance after a non-retryable connection failure", () => {
    const { manager, term } = createManager();
    const session = manager.createSession({ type: "ssh", sshConfig: { host: "example.com" } });
    term.emitStatus("connected");

    term.emitExit(1, { reason: "connection-error", retryable: false, message: "authentication failed" });

    expect(manager.listSessions()).toEqual([expect.objectContaining({
      id: session.id,
      sshConnectionState: "disconnected"
    })]);
  });

  it("cancels pending SSH reconnect when the retained instance is closed", () => {
    const clearTimeoutFn = vi.fn();
    const timer = { id: "retry" };
    const onSessionClosed = vi.fn();
    const { manager, term } = createManager({
      onSessionClosed,
      setTimeoutFn: () => timer,
      clearTimeoutFn
    });
    const session = manager.createSession({ type: "ssh", sshConfig: { host: "example.com" } });
    term.emitExit(1, { reason: "connection-error", retryable: true });

    manager.closeSession(session.id);

    expect(clearTimeoutFn).toHaveBeenCalledWith(timer);
    expect(manager.listSessions()).toEqual([]);
    expect(onSessionClosed).toHaveBeenCalledTimes(1);
  });

  it("detects Codex terminal permission prompts when no hook event is emitted", () => {
    vi.spyOn(Date, "now").mockReturnValue(444);
    const { manager, term, broadcast } = createManager();
    const session = manager.createSession({ title: "Codex" });
    const runtimeSession = manager.getSession(session.id);
    runtimeSession.agentProvider = "codex";
    runtimeSession.agentStatus = "running";

    term.emitData("Would you like to run the following command?\r\n");

    expect(broadcast).toHaveBeenCalledWith("agent:status", expect.objectContaining({
      id: session.id,
      provider: "codex",
      status: "waiting_for_permission",
      eventName: "TerminalPermissionPrompt",
      timestamp: 444
    }));
  });

  it("uses WSL distro arguments when launching WSL sessions", () => {
    const { manager, pty } = createManager();

    manager.createSession({
      title: "Ubuntu",
      type: "wsl",
      wslDistro: "Ubuntu-24.04"
    });

    expect(pty.spawn).toHaveBeenCalledWith(expect.stringContaining("wsl.exe"), ["-d", "Ubuntu-24.04"], expect.any(Object));
  });

  it("persists tags and synchronizes them across running instances of a template", () => {
    const { manager, sessionStore, broadcast } = createManager();
    const first = manager.createSession({ title: "Main", tags: ["work"] });
    manager.launchSessions([{ id: first.templateId, title: "Main" }]);

    manager.updateSession(first.templateId, { tags: ["work", "urgent"] });

    expect(sessionStore.updateLibrary).toHaveBeenCalledWith("1", expect.objectContaining({
      tags: ["work", "urgent"]
    }));
    expect(manager.listSessions()).toHaveLength(2);
    expect(manager.listSessions().every((session) => (
      session.tags?.join(",") === "work,urgent"
    ))).toBe(true);
    expect(broadcast).toHaveBeenCalledWith("sessions:changed", manager.listSessions());
  });

  it("persists the reordered runtime session order for restart restoration", () => {
    const configStore = createConfigStoreMock();
    const { manager } = createManager({ configStore });

    manager.launchSessions([
      { id: "template-a", title: "A" },
      { id: "template-a", title: "A" },
      { id: "template-b", title: "B" }
    ]);
    const [first, second, third] = manager.listSessions();

    manager.reorderRunningSessions([third.id, second.id, first.id]);

    expect(manager.listSessions().map((session) => session.id)).toEqual([
      third.id,
      second.id,
      first.id
    ]);
    expect(configStore.updateConfig).toHaveBeenLastCalledWith({
      lastActiveSessionIds: ["template-b", "template-a", "template-a"]
    });
  });

  it("starts WSL sessions in their configured Linux working directory", () => {
    const { manager, term, pty } = createManager();

    manager.createSession({
      title: "Ubuntu",
      type: "wsl",
      wslDistro: "Ubuntu-24.04",
      cwd: "/home/me/project",
      initialCommand: "pnpm dev"
    });
    term.emitData("ready");

    expect(pty.spawn).toHaveBeenCalledWith(
      expect.stringContaining("wsl.exe"),
      ["-d", "Ubuntu-24.04", "--cd", "/home/me/project"],
      expect.objectContaining({ cwd: expect.stringMatching(/Users/i) })
    );
    expect(term.writes).toEqual(["pnpm dev\r"]);
  });

  it("passes panel hook environment into WSL sessions through WSLENV", () => {
    vi.stubEnv("WSLENV", "EXISTING/p");
    const { manager, pty } = createManager();

    manager.createSession({
      title: "Ubuntu",
      type: "wsl",
      wslDistro: "Ubuntu-24.04"
    });

    expect(pty.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({
      env: expect.objectContaining({
        PANNEL_HANDLE_SESSION_ID: "run-1",
        PANNEL_HANDLE_HOOK_URL: "http://127.0.0.1:4567",
        WSLENV: "EXISTING/p:PANNEL_HANDLE_SESSION_ID/u:PANNEL_HANDLE_HOOK_URL/u"
      })
    }));
  });

  it("enables content-safe Copilot OTel export for Windows sessions", () => {
    const { manager, pty } = createManager();

    manager.createSession({
      title: "GitHub Copilot",
      type: "windows",
      cwd: "C:\\work",
      agentProvider: "copilot"
    });

    expect(pty.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({
      env: expect.objectContaining({
        COPILOT_OTEL_ENABLED: "true",
        COPILOT_OTEL_EXPORTER_TYPE: "file",
        COPILOT_OTEL_FILE_EXPORTER_PATH: expect.stringMatching(/pannel-handle-copilot-\d+-run-1\.otel\.jsonl$/),
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
        OTEL_RESOURCE_ATTRIBUTES: expect.stringContaining("pannel_handle.panel_session_id=run-1")
      })
    }));
  });

  it("passes Copilot OTel settings into WSL through WSLENV", () => {
    const { manager, pty } = createManager();

    manager.createSession({
      title: "GitHub Copilot",
      type: "wsl",
      wslDistro: "Ubuntu-24.04",
      cwd: "/work",
      agentProvider: "copilot"
    });

    expect(pty.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({
      env: expect.objectContaining({
        COPILOT_OTEL_FILE_EXPORTER_PATH: expect.stringMatching(/^\/tmp\/pannel-handle-copilot-\d+-run-1\.otel\.jsonl$/),
        WSLENV: expect.stringContaining("COPILOT_OTEL_FILE_EXPORTER_PATH/u")
      })
    }));
  });

  it("builds SSH arguments without shell string interpolation", () => {
    expect(buildSshArgs({
      host: "example.com",
      username: "deploy",
      port: 2222,
      identityFile: "C:\\Users\\tester\\.ssh\\id_ed25519",
      remoteCommand: "cd /srv/app && bash",
      extraArgs: ["-o", "ServerAliveInterval=30"]
    })).toEqual([
      "deploy@example.com",
      "-p",
      "2222",
      "-i",
      "C:\\Users\\tester\\.ssh\\id_ed25519",
      "-o",
      "ServerAliveInterval=30",
      "-t",
      "cd /srv/app && bash"
    ]);
  });

  it("creates SSH sessions with ssh2 and persists the template", () => {
    const { manager, pty, ssh2TerminalFactory, sessionStore } = createManager();

    const session = manager.createSession({
      type: "ssh",
      sshConfig: {
        host: "example.com",
        username: "deploy",
        port: 2222,
        identityFile: "package.json"
      }
    });

    expect(session).toMatchObject({
      title: "deploy@example.com",
      shell: "ssh2",
      type: "ssh",
      sshConfig: expect.objectContaining({
        host: "example.com",
        username: "deploy",
        port: 2222
      })
    });
    expect(sessionStore.addToLibrary).toHaveBeenCalledWith(expect.objectContaining({
      type: "ssh",
      sshConfig: expect.objectContaining({ host: "example.com" })
    }));
    expect(pty.spawn).not.toHaveBeenCalled();
    expect(ssh2TerminalFactory).toHaveBeenCalledWith(expect.objectContaining({
      connectionConfig: expect.objectContaining({
        host: "example.com",
        username: "deploy",
        port: 2222
      })
    }));
  });

  it("writes the SSH working directory before the initial command", () => {
    const { manager, term } = createManager();

    manager.createSession({
      type: "ssh",
      cwd: "/srv/app's repo",
      initialCommand: "pnpm dev",
      sshConfig: {
        host: "example.com",
        username: "deploy"
      }
    });
    term.emitData("ready");

    expect(term.writes).toEqual(["cd '/srv/app'\\''s repo' && pnpm dev\r"]);
  });

  it("writes only the SSH initial command when the working directory is home", () => {
    const { manager, term } = createManager();

    manager.createSession({
      type: "ssh",
      cwd: "~",
      initialCommand: "pnpm dev",
      sshConfig: {
        host: "example.com",
        username: "deploy"
      }
    });
    term.emitData("ready");

    expect(term.writes).toEqual(["pnpm dev\r"]);
  });

  it("reports status changes without allowing callback failures to block broadcasts", () => {
    const onAgentStatusChanged = vi.fn(() => {
      throw new Error("notification failed");
    });
    const { manager, broadcast } = createManager({ onAgentStatusChanged });

    expect(() => manager.broadcastAgentStatus({
      id: "run-1",
      provider: "codex",
      status: "completed",
      eventName: "Stop"
    })).not.toThrow();

    expect(broadcast).toHaveBeenCalledWith("agent:status", expect.objectContaining({
      id: "run-1",
      provider: "codex",
      status: "completed",
      eventName: "Stop"
    }));
    expect(onAgentStatusChanged).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      status: "completed"
    }));
  });

  it("does not expose encrypted SSH secrets in serialized sessions", () => {
    const { manager } = createManager();

    const session = manager.createSession({
      type: "ssh",
      sshConfig: {
        host: "example.com",
        username: "deploy",
        encryptedSecret: "ciphertext"
      }
    });

    expect(session.sshConfig).toMatchObject({
      host: "example.com",
      hasSecret: true
    });
    expect(session.sshConfig.encryptedSecret).toBeUndefined();
  });

  it("passes a saved SSH password into ssh2 and still writes it for terminal password prompts", () => {
    const { manager, term, sessionStore, ssh2TerminalFactory } = createManager();

    manager.createSession({
      type: "ssh",
      sshConfig: {
        host: "example.com",
        username: "deploy",
        encryptedSecret: "ciphertext"
      }
    });

    term.emitData("deploy@example.com's password: ");

    expect(sessionStore.decryptSecret).toHaveBeenCalledWith("ciphertext");
    expect(ssh2TerminalFactory).toHaveBeenCalledWith(expect.objectContaining({
      connectionConfig: expect.objectContaining({
        password: "plain-secret",
        tryKeyboard: true
      })
    }));
    expect(term.writes).toEqual(["plain-secret\r"]);
  });

  it("never writes an SSH secret into a deferred local Agent terminal", () => {
    const { manager, term, pty, ssh2TerminalFactory } = createManager();
    const session = manager.createSession({
      type: "ssh",
      cwd: "/srv/app",
      agentProvider: "codex",
      agentLocation: "local",
      deferTerminalStart: true,
      sshConfig: { host: "example.com", encryptedSecret: "ciphertext" }
    });

    manager.startDeferredSession(session.id, {
      terminalTransport: "local-agent",
      runtimeShell: "cmd.exe",
      runtimeCwd: "C:\\runtime\\run-1",
      runtimeInitialCommand: ""
    });
    term.emitData("password: ");

    expect(pty.spawn).toHaveBeenCalledWith("cmd.exe", [], expect.objectContaining({ cwd: "C:\\runtime\\run-1" }));
    expect(ssh2TerminalFactory).not.toHaveBeenCalled();
    expect(term.writes).toEqual([]);
  });

  it("writes a saved SSH secret for root password prompts with terminal control sequences", () => {
    const { manager, term } = createManager();

    manager.createSession({
      type: "ssh",
      sshConfig: {
        host: "10.227.17.2",
        username: "root",
        encryptedSecret: "ciphertext"
      }
    });

    term.emitData("\x1b]0;ssh root@10.227.17.2\x07root@10.227.17.2's password:\r");

    expect(term.writes).toEqual(["plain-secret\r"]);
  });

  it("writes a saved SSH secret when ssh asks for a key passphrase", () => {
    const { manager, term } = createManager();

    manager.createSession({
      type: "ssh",
      sshConfig: {
        host: "example.com",
        identityFile: "package.json",
        encryptedSecret: "ciphertext"
      }
    });

    term.emitData("Enter passphrase for key 'C:\\Users\\tester\\.ssh\\id_ed25519': ");

    expect(term.writes).toEqual(["plain-secret\r"]);
  });

  it("does not repeat a saved SSH secret when the accepted password prompt is followed by a newline", () => {
    const { manager, term } = createManager();

    manager.createSession({
      type: "ssh",
      sshConfig: {
        host: "example.com",
        encryptedSecret: "ciphertext"
      }
    });

    term.emitData("password: ");
    term.emitData("\r\n");
    term.emitData("\x1b[?2004h");

    expect(term.writes).toEqual(["plain-secret\r"]);
  });

  it("writes a saved SSH secret again when ssh shows a new password prompt after failure", () => {
    const { manager, term } = createManager();

    manager.createSession({
      type: "ssh",
      sshConfig: {
        host: "example.com",
        encryptedSecret: "ciphertext"
      }
    });

    term.emitData("password: ");
    term.emitData("\r\nPermission denied, please try again.\r\npassword: ");

    expect(term.writes).toEqual(["plain-secret\r", "plain-secret\r"]);
  });

  it("limits automatic SSH secret writes to two prompts", () => {
    const { manager, term } = createManager();

    manager.createSession({
      type: "ssh",
      sshConfig: {
        host: "example.com",
        encryptedSecret: "ciphertext"
      }
    });

    term.emitData("password: ");
    term.emitData("password: ");
    term.emitData("password: ");

    expect(term.writes).toEqual(["plain-secret\r", "plain-secret\r"]);
  });

  it("does not write SSH secrets when no saved secret exists", () => {
    const { manager, term } = createManager();

    manager.createSession({
      type: "ssh",
      sshConfig: {
        host: "example.com"
      }
    });

    term.emitData("password: ");

    expect(term.writes).toEqual([]);
  });

  it("rejects SSH sessions without a host before persisting", () => {
    const { manager, sessionStore, pty, ssh2TerminalFactory } = createManager();

    expect(() => manager.createSession({
      type: "ssh",
      sshConfig: { username: "deploy" }
    })).toThrow("SSH host is required.");
    expect(sessionStore.addToLibrary).not.toHaveBeenCalled();
    expect(pty.spawn).not.toHaveBeenCalled();
    expect(ssh2TerminalFactory).not.toHaveBeenCalled();
  });

  it("rejects SSH sessions with extra arguments before persisting", () => {
    const { manager, sessionStore, pty, ssh2TerminalFactory } = createManager();

    expect(() => manager.createSession({
      type: "ssh",
      sshConfig: {
        host: "example.com",
        extraArgs: ["-o", "ServerAliveInterval=30"]
      }
    })).toThrow("SSH extra arguments are not supported by the ssh2 backend.");
    expect(sessionStore.addToLibrary).not.toHaveBeenCalled();
    expect(pty.spawn).not.toHaveBeenCalled();
    expect(ssh2TerminalFactory).not.toHaveBeenCalled();
  });
});
