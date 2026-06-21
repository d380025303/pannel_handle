import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createListenerAgentManager, diffSnapshots, matchesTrigger } = require("./listener-agent-manager.cjs");

afterEach(() => vi.useRealTimers());

describe("listener Agent file matching", () => {
  const trigger = { include: ["src/**/*.ts"], exclude: ["**/*.test.ts"] };

  it("applies include and exclude globs", () => {
    expect(matchesTrigger(trigger, "src/app/main.ts")).toBe(true);
    expect(matchesTrigger(trigger, "src/app/main.test.ts")).toBe(false);
    expect(matchesTrigger(trigger, "README.md")).toBe(false);
  });

  it("detects added, changed, and deleted files", () => {
    const previous = new Map([["old.ts", "1"], ["changed.ts", "1"]]);
    const next = new Map([["new.ts", "1"], ["changed.ts", "2"]]);
    expect(diffSnapshots(previous, next)).toEqual(expect.arrayContaining([
      { event: "add", path: "new.ts" },
      { event: "change", path: "changed.ts" },
      { event: "unlink", path: "old.ts" }
    ]));
  });

  it("uses the oldest runtime host and serializes merged triggers", async () => {
    vi.useFakeTimers();
    let sessions = [
      { id: "run-2", templateId: "1", createdAt: 2, type: "windows", cwd: "C:\\work" },
      { id: "run-1", templateId: "1", createdAt: 1, type: "windows", cwd: "C:\\work" }
    ];
    const trigger = { id: "t1", name: "Timer", type: "interval", enabled: true, prompt: "Review", intervalMinutes: 60 };
    const agent = { id: "a1", name: "Agent", provider: "codex", enabled: true, permission: "read-only", timeoutMinutes: 30, ignoreOwnChanges: true, triggers: [trigger] };
    const resolvers = [];
    const cli = { run: vi.fn(async () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      resolvers.push(resolve);
      return { promise, cancel: vi.fn() };
    }) };
    const manager = createListenerAgentManager({
      terminalManager: { getSessions: () => sessions },
      sessionStore: { getTemplate: () => ({ id: "1", listenerAgents: [agent] }) },
      historyStore: { append: vi.fn(), list: () => [], clear: vi.fn(), removeTemplate: vi.fn() },
      cli,
      sshSessionRuntime: {},
      broadcast: vi.fn()
    });

    await manager.sync("1");
    expect(manager.stateFor("1").hostSessionId).toBe("run-1");
    manager.runNow("1", "a1", "t1");
    await vi.advanceTimersByTimeAsync(0);
    manager.runNow("1", "a1", "t1");
    expect(manager.stateFor("1")).toMatchObject({ agents: [{ running: true, pending: true }] });
    expect(cli.run).toHaveBeenCalledTimes(1);

    resolvers[0]({ exitCode: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(cli.run).toHaveBeenCalledTimes(2);

    sessions = [sessions[0]];
    await manager.sync("1");
    expect(manager.stateFor("1").hostSessionId).toBe("run-2");
    manager.shutdown();
  });

  it("resolves cliTemplateId to template config for CLI execution", async () => {
    vi.useFakeTimers();
    const sessions = [{ id: "run-1", templateId: "1", createdAt: 1, type: "windows", cwd: "C:\\work" }];
    const trigger = { id: "t1", name: "Timer", type: "interval", enabled: true, prompt: "Review", intervalMinutes: 60 };
    const agent = {
      id: "a1", name: "Agent", provider: "codex", cliTemplateId: "tpl-2",
      enabled: true, permission: "read-only", timeoutMinutes: 30,
      ignoreOwnChanges: true, triggers: [trigger]
    };
    const cliTemplate = { id: "tpl-2", title: "WSL Codex", agentProvider: "codex", type: "wsl", cwd: "/home/dev", wslDistro: "Ubuntu" };
    const cli = { run: vi.fn(async () => ({ promise: Promise.resolve({ exitCode: 0 }), cancel: vi.fn() })) };
    const manager = createListenerAgentManager({
      terminalManager: { getSessions: () => sessions },
      sessionStore: {
        getTemplate: (id) => id === "tpl-2" ? cliTemplate : { id: "1", listenerAgents: [agent] }
      },
      historyStore: { append: vi.fn(), list: () => [], clear: vi.fn(), removeTemplate: vi.fn() },
      cli, sshSessionRuntime: {}, broadcast: vi.fn()
    });

    await manager.sync("1");
    manager.runNow("1", "a1", "t1");
    await vi.advanceTimersByTimeAsync(0);

    const actualSession = cli.run.mock.calls[0][0];
    expect(actualSession.cwd).toBe("/home/dev");
    expect(actualSession.type).toBe("wsl");
    expect(actualSession.wslDistro).toBe("Ubuntu");

    manager.shutdown();
  });

  it("debounces matching Windows file changes into one Agent run", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "listener-watch-"));
    const trigger = { id: "t1", name: "Files", type: "file", enabled: true, prompt: "Review", include: ["src/**/*.ts"], exclude: ["**/node_modules/**"], events: ["add", "change", "unlink"], debounceMs: 1000 };
    const agent = { id: "a1", name: "Agent", provider: "codex", enabled: true, permission: "read-only", timeoutMinutes: 30, ignoreOwnChanges: true, triggers: [trigger] };
    const cli = { run: vi.fn(async () => ({ promise: Promise.resolve({ exitCode: 0 }), cancel: vi.fn() })) };
    const manager = createListenerAgentManager({
      terminalManager: { getSessions: () => [{ id: "run-1", templateId: "1", createdAt: 1, type: "windows", cwd }] },
      sessionStore: { getTemplate: () => ({ id: "1", listenerAgents: [agent] }) },
      historyStore: { append: vi.fn(), list: () => [], clear: vi.fn(), removeTemplate: vi.fn() },
      cli, sshSessionRuntime: {}, broadcast: vi.fn()
    });
    try {
      await manager.sync("1");
      await new Promise(resolve => setTimeout(resolve, 200));
      fs.mkdirSync(path.join(cwd, "src"));
      fs.writeFileSync(path.join(cwd, "src", "one.ts"), "one");
      fs.writeFileSync(path.join(cwd, "src", "two.ts"), "two");
      await vi.waitFor(() => expect(cli.run).toHaveBeenCalledTimes(1), { timeout: 3500 });
      expect(cli.run.mock.calls[0][2]).toContain("one.ts");
      expect(cli.run.mock.calls[0][2]).toContain("two.ts");
    } finally {
      manager.shutdown();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
