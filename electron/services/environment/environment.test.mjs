import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createEnvironmentService, normalizeEntries, mergeEnvironment } = require("./index.cjs");
const { createSessionStore } = require("../../stores/session-store.cjs");
const { createTemplateUsageStore } = require("../../stores/template-usage-store.cjs");
const { createTerminalManager } = require("../../terminal/terminal-manager.cjs");
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-env-")); dirs.push(dir);
  let references = [];
  const configFile = path.join(dir, "env.json");
  const service = createEnvironmentService({ configFile, getReferences: () => references });
  const store = createSessionStore({ sessionsFile: path.join(dir, "sessions.json"), environmentService: service, getDefaultShell: () => "cmd.exe", getWslShell: () => "wsl.exe" });
  return { dir, configFile, service, store, setReferences: value => { references = value; } };
}

describe("environment profiles", () => {
  it("fetches references once per list with 500 templates and 100 launches each", () => {
    const profiles = Array.from({ length: 50 }, (_, i) => ({ id: `profile-${i}`, name: `group-${i}`, entries: [{ name: "FOO", value: String(i) }] }));
    const templates = Array.from({ length: 500 }, (_, i) => ({ id: String(i + 1), type: "windows", title: `terminal-${i % 7}`, environmentProfileId: profiles[i % 49].id }));
    const now = 1_800_000_000_000;
    const values = new Map([
      ["env.json", profiles],
      ["sessions.json", templates],
      ["usage.json", Object.fromEntries(templates.map(t => [t.id, Array.from({ length: 100 }, (_, i) => now - i)]))]
    ]);
    const dataStore = { read: file => structuredClone(values.get(file)), write: (file, value) => values.set(file, structuredClone(value)) };
    const usageStore = createTemplateUsageStore({ usageFile: "usage.json", dataStore, now: () => now });
    usageStore.load();
    const store = createSessionStore({ sessionsFile: "sessions.json", dataStore, templateUsageStore: usageStore, getDefaultShell: () => "cmd.exe", getWslShell: () => "wsl.exe" });
    store.loadLibrary();
    let activeSessions = [templates[0], { title: "unknown", environmentProfileId: "missing" }, { title: "unassigned" }];
    const getReferences = vi.fn(() => [...store.getLibrary(), ...activeSessions]);
    const service = createEnvironmentService({ configFile: "env.json", dataStore, getReferences });
    expect(store.getLibrary()[0].recentLaunchCount).toBe(100);
    const references = [...store.getLibrary(), ...activeSessions];
    const expected = profiles.map(p => ({ ...p, references: references.filter(s => s.environmentProfileId === p.id).map(s => s.title) }));
    const result = service.list();
    expect(getReferences).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expected);
    result[0].references.push("mutated");
    result[0].entries[0].value = "mutated";
    expect(service.list()).toEqual(expected);
    expect(getReferences).toHaveBeenCalledTimes(2);
    activeSessions = [{ title: "new session", environmentProfileId: profiles[49].id }];
    expect(service.list()[49].references).toEqual(["new session"]);
    expect(getReferences).toHaveBeenCalledTimes(3);
  });
  it("persists groups, overrides without leaking into other sessions, and exports portable snapshots", () => {
    const { service, store, configFile } = harness();
    const [profile] = service.save({ name: "dev", entries: [{ name: "FOO", value: "group" }] });
    const session = { id: "1", type: "windows", environmentProfileId: profile.id, environmentOverrides: [{ name: "FOO", value: "" }] };
    expect(service.resolve(session)).toEqual({ FOO: "" });
    expect(service.resolve({ environmentProfileId: profile.id })).toEqual({ FOO: "group" });
    expect(createEnvironmentService({ configFile }).list()[0].entries).toEqual(profile.entries);
    store.addToLibrary(session);
    const [exported] = store.exportLibrary();
    expect(exported).not.toHaveProperty("environmentProfileId");
    expect(exported.environmentOverrides).toEqual([{ name: "FOO", value: "" }]);
    expect(store.importLibrary([exported]).sessions.at(-1).environmentOverrides).toEqual(exported.environmentOverrides);
    store.updateLibrary("1", { environmentProfileId: null, environmentOverrides: [] });
    expect(service.resolve(store.getTemplate("1"))).toEqual({});
  });
  it("protects referenced groups and rejects missing groups", () => {
    const { service, setReferences } = harness();
    const [p] = service.save({ name: "dev", entries: [] });
    setReferences([{ title: "工作终端", environmentProfileId: p.id }]);
    expect(() => service.remove(p.id)).toThrow("工作终端");
    expect(service.list()[0].references).toEqual(["工作终端"]);
    setReferences([]); service.remove(p.id);
    expect(() => service.resolve({ environmentProfileId: p.id })).toThrow("不存在");
  });
  it("validates names and values, preserving case-sensitive Linux variables", () => {
    for (const name of ["1BAD", "A=B", "WSLENV", "pannel_handle_test", ""]) expect(() => normalizeEntries([{ name, value: "x" }])).toThrow();
    expect(() => normalizeEntries([{ name: "A", value: "a\0b" }])).toThrow();
    const entries = [{ name: "Path", value: "a" }, { name: "PATH", value: "b" }];
    expect(normalizeEntries(entries)).toEqual(entries);
    expect(() => normalizeEntries(entries, true)).toThrow("重复");
    expect(mergeEnvironment([{ Path: "base" }, { PATH: "user" }, { path: "runtime" }], true)).toEqual({ path: "runtime" });
  });
  it("launches Windows, WSL and SSH with isolated environment and preserves metadata on update", () => {
    const { service, store } = harness();
    const [p] = service.save({ name: "dev", entries: [{ name: "TEST_PANEL_ENV", value: "group" }] });
    const term = { onData: () => ({ dispose() {} }), onExit() {}, write() {}, resize() {}, kill() {} };
    const spawn = vi.fn(() => term);
    const ssh = vi.fn(() => term);
    const manager = createTerminalManager({ sessionStore: store, environmentService: service, pty: { spawn }, ssh2TerminalFactory: ssh, broadcast() {}, getHookUrl: () => "http://hook" });
    const session = manager.createSession({ type: "windows", environmentProfileId: p.id, environmentOverrides: [{ name: "TEST_PANEL_ENV", value: "session" }] });
    expect(spawn.mock.calls[0][2].env).toMatchObject({ TEST_PANEL_ENV: "session", PANNEL_HANDLE_HOOK_URL: "http://hook" });
    manager.createSession({ type: "windows" });
    expect(spawn.mock.calls[1][2].env.TEST_PANEL_ENV).toBeUndefined();
    manager.createSession({ type: "wsl", wslDistro: "Ubuntu", environmentProfileId: p.id });
    expect(spawn.mock.calls[2][2].env.WSLENV).toContain("TEST_PANEL_ENV/u");
    manager.createSession({ type: "ssh", sshConfig: { host: "server", username: "user" }, environmentProfileId: p.id });
    expect(ssh.mock.calls[0][0].environment).toEqual({ TEST_PANEL_ENV: "group" });
    expect(() => manager.createSession({ type: "ssh", sshConfig: { host: "server", remotePlatform: "windows" }, environmentProfileId: p.id })).toThrow("Linux");
    manager.createSession({ type: "ssh", agentProvider: "codex", agentLocation: "local", sshConfig: { host: "server" }, environmentProfileId: p.id,
      terminalTransport: "local-agent", runtimeShell: "cmd.exe", runtimeEnv: { test_panel_env: "runtime" } });
    expect(spawn.mock.calls[3][2].env.test_panel_env).toBe("runtime");
    expect(spawn.mock.calls[3][2].env.TEST_PANEL_ENV).toBeUndefined();
    expect(ssh).toHaveBeenCalledTimes(1);
    manager.updateSession(session.id, { environmentProfileId: null, environmentOverrides: [] });
    expect(manager.listSessions()[0].environmentOverrides).toEqual([]);
    expect(store.getTemplate(session.templateId).environmentProfileId).toBeUndefined();
  });
});
