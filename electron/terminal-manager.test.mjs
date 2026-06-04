import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createTerminalManager } = require("./terminal-manager.cjs");

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
  const broadcast = vi.fn();
  const templates = new Map();
  const sessionStore = {
    createTemplateId: vi.fn(() => "1"),
    normalizeTemplate: vi.fn((template) => ({
      id: template.id,
      title: template.title,
      shell: template.shell || "powershell.exe",
      cwd: template.cwd || "C:\\Users\\tester",
      createdAt: template.createdAt || 111,
      initialCommand: template.initialCommand,
      type: template.type || "windows",
      wslDistro: template.wslDistro
    })),
    addToLibrary: vi.fn((template) => templates.set(template.id, template)),
    removeFromLibrary: vi.fn(),
    updateLibrary: vi.fn((id, updates) => {
      templates.set(id, { ...(templates.get(id) || { id }), ...updates });
    }),
    getTemplate: vi.fn((id) => templates.get(id))
  };
  const manager = createTerminalManager({
    sessionStore,
    broadcast,
    getHookUrl: () => "http://127.0.0.1:4567",
    pty,
    ...overrides
  });

  return { manager, term, pty, broadcast, sessionStore };
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

  it("uses WSL distro arguments when launching WSL sessions", () => {
    const { manager, pty } = createManager();

    manager.createSession({
      title: "Ubuntu",
      type: "wsl",
      wslDistro: "Ubuntu-24.04"
    });

    expect(pty.spawn).toHaveBeenCalledWith(expect.stringContaining("wsl.exe"), ["-d", "Ubuntu-24.04"], expect.any(Object));
  });
});
