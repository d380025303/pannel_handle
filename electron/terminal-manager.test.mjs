import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { buildSshArgs, createTerminalManager } = require("./terminal-manager.cjs");

function createMockTerm() {
  const dataHandlers = [];
  const exitHandlers = [];

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
    emitExit(exitCode) {
      for (const callback of [...exitHandlers]) callback({ exitCode });
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
      createdAt: template.createdAt || 111,
      initialCommand: template.initialCommand,
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

  it("can close a legacy runtime session that has no terminal instance", () => {
    const { manager, broadcast } = createManager();
    const session = manager.createSession({ title: "Broken" });
    manager.getSession(session.id).term = undefined;

    expect(() => manager.write(session.id, "abc")).not.toThrow();
    expect(() => manager.resize(session.id, 90, 24)).not.toThrow();
    expect(manager.closeSession(session.id)).toEqual([]);
    expect(broadcast).toHaveBeenLastCalledWith("sessions:changed", []);
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
