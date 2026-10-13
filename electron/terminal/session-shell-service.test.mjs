import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createSessionShellService } = require("./session-shell-service.cjs");

function fakeTerminal() {
  const listeners = { data: [], exit: [] };
  return {
    listeners,
    onData: vi.fn(callback => { listeners.data.push(callback); return { dispose() {} }; }),
    onExit: vi.fn(callback => { listeners.exit.push(callback); return { dispose() {} }; }),
    write: vi.fn(), resize: vi.fn(), kill: vi.fn()
  };
}

function setup(session) {
  const term = fakeTerminal();
  const pty = { spawn: vi.fn(() => term) };
  const sshTerminalFactory = vi.fn(() => term);
  const broadcast = vi.fn();
  const service = createSessionShellService({
    terminalManager: { getSession: id => id === session.id ? session : undefined },
    environmentService: { resolve: () => ({ TASK_VAR: "value" }) },
    sessionStore: { decryptSecret: () => "secret" },
    broadcast, pty, sshTerminalFactory
  });
  return { service, term, pty, sshTerminalFactory, broadcast };
}

describe("graphical session shell", () => {
  it("starts one ordinary Windows shell per graphical session and keeps it until the last owner closes", () => {
    const session = { id: "g1", runtimeMode: "app-server", type: "windows", shell: "pwsh.exe",
      cwd: "C:\\repo", agentProvider: "codex", initialCommand: "codex" };
    const { service, pty, term, broadcast } = setup(session);
    const first = service.open("g1", "owner-1");
    service.open("g1", "owner-2");
    expect(pty.spawn).toHaveBeenCalledTimes(1);
    expect(pty.spawn).toHaveBeenCalledWith("pwsh.exe", [], expect.objectContaining({ cwd: "C:\\repo", env: expect.objectContaining({ TASK_VAR: "value" }) }));
    term.listeners.data[0]("hello");
    expect(broadcast).toHaveBeenCalledWith("session-shell:data", expect.objectContaining({ id: "g1", generation: first.generation, seq: 1, data: "hello" }));
    service.write("g1", first.generation, "pwd\r");
    service.resize("g1", first.generation, 90, 24);
    expect(term.write).toHaveBeenCalledWith("pwd\r");
    expect(term.resize).toHaveBeenCalledWith(90, 24);
    service.close("g1", "owner-1");
    expect(term.kill).not.toHaveBeenCalled();
    service.close("g1", "owner-2");
    expect(term.kill).toHaveBeenCalledTimes(1);
    service.write("g1", first.generation, "ignored");
    expect(term.write).toHaveBeenCalledTimes(1);
  });

  it("bounds 1000 large callbacks and preserves live output and sequence", () => {
    const { service, term, broadcast } = setup({ id: "g1", runtimeMode: "app-server", type: "windows", shell: "pwsh.exe" });
    const first = service.open("g1", "owner");
    const chunk = "x".repeat(32 * 1024);
    for (let i = 0; i < 1000; i++) term.listeners.data[0](chunk);
    expect(Buffer.byteLength(service.open("g1", "reader").history)).toBe(2 * 1024 * 1024);
    term.listeners.data[0]("LATEST");
    const result = service.open("g1", "reader");
    expect(Buffer.byteLength(result.history)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(result.history.endsWith("LATEST")).toBe(true);
    expect(result.seq).toBe(1001);
    expect(result.generation).toBe(first.generation);
    expect(broadcast).toHaveBeenCalledTimes(1001);
    expect(broadcast).toHaveBeenLastCalledWith("session-shell:data", expect.objectContaining({ seq: 1001, data: "LATEST" }));
  });

  it("retains a Unicode-safe suffix of a single oversized callback", () => {
    const { service, term, broadcast } = setup({ id: "g1", runtimeMode: "app-server", type: "windows" });
    service.open("g1", "owner");
    const data = "😀界".repeat(400000) + "LATEST";
    term.listeners.data[0](data);
    const { history } = service.open("g1", "reader");
    expect(Buffer.byteLength(history)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(data.endsWith(history)).toBe(true);
    expect(history).toMatch(/^(😀|界)/u);
    expect(history.endsWith("LATEST")).toBe(true);
    expect(broadcast).toHaveBeenLastCalledWith("session-shell:data", expect.objectContaining({ data }));
  });

  it.each(["\x1b[" + "1;".repeat(1100000) + "m", "\x1b]0;" + "x".repeat(2200000) + "\x1b\\", "\x1bP" + "x".repeat(2200000) + "\x1b\\"])("does not replay a partial oversized ANSI sequence", sequence => {
    const { service, term } = setup({ id: "g1", runtimeMode: "app-server", type: "windows" });
    service.open("g1", "owner");
    term.listeners.data[0](sequence + "LATEST");
    expect(service.open("g1", "reader").history).toBe("LATEST");
  });

  it("drops cross-callback control payloads after eviction and keeps the block limit", () => {
    const { service, term } = setup({ id: "g1", runtimeMode: "app-server", type: "windows" });
    service.open("g1", "owner");
    term.listeners.data[0]("\x1b]0;");
    term.listeners.data[0]("x".repeat(2200000));
    expect(service.open("g1", "reader").history).toBe("");
    term.listeners.data[0]("payload\x07LATEST");
    expect(service.open("g1", "reader").history).toBe("LATEST");
    for (let i = 0; i < 1001; i++) term.listeners.data[0]("a");
    expect(service.open("g1", "reader").history).toBe("a".repeat(1000));
  });

  it("uses the selected WSL distribution and working directory without an Agent command", () => {
    const { service, pty } = setup({ id: "w1", runtimeMode: "app-server", type: "wsl",
      shell: "unused", wslDistro: "Ubuntu", cwd: "/home/me/project", initialCommand: "codex" });
    service.open("w1", "owner");
    expect(pty.spawn).toHaveBeenCalledWith("C:\\Windows\\System32\\wsl.exe",
      ["-d", "Ubuntu", "--cd", "/home/me/project"],
      expect.objectContaining({ env: expect.objectContaining({ WSLENV: expect.stringContaining("TASK_VAR/u") }) }));
  });

  it("connects to the same SSH target and closes when its parent session closes", () => {
    const session = { id: "s1", runtimeMode: "app-server", type: "ssh", cwd: "/srv/repo",
      sshConfig: { host: "example.test", username: "me", encryptedSecret: "encrypted" } };
    const { service, term, sshTerminalFactory } = setup(session);
    service.open("s1", "owner");
    expect(sshTerminalFactory).toHaveBeenCalledWith(expect.objectContaining({
      connectionConfig: expect.objectContaining({ host: "example.test", username: "me", password: "secret" }),
      environment: { TASK_VAR: "value" }
    }));
    for (const listener of term.listeners.data) listener("prompt");
    expect(term.write).toHaveBeenCalledWith("cd '/srv/repo'\r");
    service.close("s1");
    expect(term.kill).toHaveBeenCalledTimes(1);
  });

  it("rejects a closed or non graphical session", () => {
    const { service } = setup({ id: "t1", runtimeMode: "terminal", type: "windows" });
    expect(() => service.open("t1", "owner")).toThrow("图形会话已关闭");
    expect(() => service.open("missing", "owner")).toThrow("图形会话已关闭");
  });

  it("starts a fresh shell after the previous process exits", () => {
    const session = { id: "g2", runtimeMode: "app-server", type: "windows", shell: "cmd.exe", cwd: "C:\\repo" };
    const firstTerm = fakeTerminal();
    const secondTerm = fakeTerminal();
    const pty = { spawn: vi.fn().mockReturnValueOnce(firstTerm).mockReturnValueOnce(secondTerm) };
    const service = createSessionShellService({ terminalManager: { getSession: () => session }, pty, broadcast: vi.fn() });
    const first = service.open("g2", "owner-1");
    firstTerm.listeners.exit[0]({ exitCode: 0 });
    const second = service.open("g2", "owner-2");
    expect(second.generation).not.toBe(first.generation);
    expect(firstTerm.kill).toHaveBeenCalledTimes(1);
    service.write("g2", first.generation, "ignored");
    expect(secondTerm.write).not.toHaveBeenCalled();
  });
});
