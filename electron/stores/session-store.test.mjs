import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createSessionStore, inferWorkingDirectory, normalizeTags } = require("./session-store.cjs");

let tempDirs = [];

function createTempSessionsFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "pannel-handle-sessions-"));
  tempDirs.push(dir);
  return path.join(dir, "sessions.json");
}

function createSafeStorageMock() {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value) => Buffer.from(`encrypted:${value}`, "utf-8")),
    decryptString: vi.fn((value) => value.toString("utf-8").replace(/^encrypted:/, ""))
  };
}

function createStore(sessionsFile, safeStorage = createSafeStorageMock(), templateUsageStore, launchTemplateStore) {
  return createSessionStore({
    sessionsFile,
    getDefaultShell: () => "powershell.exe",
    getWslShell: () => "wsl.exe",
    safeStorage,
    templateUsageStore,
    launchTemplateStore
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("session-store", () => {
  it("keeps existing Grok templates terminal-based until explicitly enabled", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "old", type: "windows", cwd: "C:\\work", agentProvider: "grok", graphicalSessionEnabled: true },
      { id: "old-wsl", type: "wsl", cwd: "/work", agentProvider: "grok", graphicalSessionEnabled: false }
    ]));
    const store = createStore(sessionsFile);
    store.loadLibrary();
    expect(store.getTemplate("old").graphicalSessionEnabled).toBe(false);
    expect(store.getTemplate("old-wsl").graphicalSessionEnabled).toBe(false);
    store.updateLibrary("old", { graphicalSessionEnabled: true });
    expect(createStore(sessionsFile).loadLibrary().find(template => template.id === "old").graphicalSessionEnabled).toBe(true);
    store.addToLibrary({ id: "new", type: "windows", cwd: "C:\\work", agentProvider: "grok", graphicalSessionEnabled: true });
    expect(createStore(sessionsFile).loadLibrary().find(template => template.id === "new").graphicalSessionEnabled).toBe(true);
    store.importLibrary([{ id: "imported", type: "windows", cwd: "C:\\work", agentProvider: "grok", graphicalSessionEnabled: true }]);
    expect(store.getLibrary().at(-1).graphicalSessionEnabled).toBe(false);
  });
  it("keeps existing Gemini templates terminal-based until explicitly enabled", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "old", type: "windows", cwd: "C:\\work", agentProvider: "gemini", graphicalSessionEnabled: true },
      { id: "old-wsl", type: "wsl", cwd: "/work", agentProvider: "gemini", graphicalSessionEnabled: false }
    ]));
    const store = createStore(sessionsFile);
    store.loadLibrary();
    expect(store.getTemplate("old").graphicalSessionEnabled).toBe(false);
    expect(store.getTemplate("old-wsl").graphicalSessionEnabled).toBe(false);
    store.updateLibrary("old", { graphicalSessionEnabled: true });
    expect(store.getTemplate("old").graphicalSessionEnabled).toBe(true);
    const reopened = createStore(sessionsFile);
    reopened.loadLibrary();
    expect(reopened.getTemplate("old").graphicalSessionEnabled).toBe(true);
    store.addToLibrary({ id: "new", type: "windows", cwd: "C:\\work", agentProvider: "gemini", graphicalSessionEnabled: true });
    expect(createStore(sessionsFile).loadLibrary().find(template => template.id === "new").graphicalSessionEnabled).toBe(true);
    store.importLibrary([{ id: "imported", type: "windows", cwd: "C:\\work", agentProvider: "gemini", graphicalSessionEnabled: true }]);
    expect(store.getLibrary().at(-1).graphicalSessionEnabled).toBe(false);
  });
  it("keeps old Qoder templates terminal-based until graphical mode is enabled", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([{ id: "qoder", type: "windows", cwd: "C:\\work", agentProvider: "qoder" }]));
    const store = createStore(sessionsFile);
    store.loadLibrary();
    expect(store.getTemplate("qoder").graphicalSessionEnabled).toBe(false);
    store.updateLibrary("qoder", { graphicalSessionEnabled: true });
    expect(store.getTemplate("qoder").graphicalSessionEnabled).toBe(true);
  });
  it("keeps old Claude templates terminal-based while accepting an explicit graphical choice", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([{ id: "claude", type: "windows", cwd: "C:\\work", agentProvider: "claude" }]));
    const store = createStore(sessionsFile);
    store.loadLibrary();
    expect(store.getTemplate("claude").graphicalSessionEnabled).toBe(false);
    store.updateLibrary("claude", { graphicalSessionEnabled: true });
    expect(store.getTemplate("claude").graphicalSessionEnabled).toBe(true);
  });
  it("keeps existing OpenCode templates in terminal mode and persists an explicit ACP choice", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([{ id: "old", type: "windows", cwd: "C:\\work", agentProvider: "opencode" }]));
    const store = createStore(sessionsFile);
    store.loadLibrary();
    expect(store.getTemplate("old").graphicalSessionEnabled).toBe(false);
    store.updateLibrary("old", { graphicalSessionEnabled: true });
    expect(store.getTemplate("old").graphicalSessionEnabled).toBe(true);
    expect(store.duplicateInLibrary("old").graphicalSessionEnabled).toBe(true);
    expect(store.exportLibrary()[0].graphicalSessionEnabled).toBe(true);
  });
  it("migrates each old provider choice into one setting and retains it after a provider change", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "codex", type: "windows", agentProvider: "codex", codexAppServerEnabled: false, codeBuddyAcpEnabled: true },
      { id: "buddy", type: "windows", agentProvider: "codebuddy", codeBuddyAcpEnabled: true, codexAppServerEnabled: false },
      { id: "open", type: "windows", agentProvider: "opencode", openCodeAcpEnabled: false, codexAppServerEnabled: true },
      { id: "terminal", type: "windows" }
    ]));
    const store = createStore(sessionsFile);
    store.loadLibrary();
    expect(store.getLibrary().map(template => template.graphicalSessionEnabled)).toEqual([false, true, false, true]);
    store.updateLibrary("codex", { agentProvider: "opencode" });
    expect(store.getTemplate("codex").graphicalSessionEnabled).toBe(false);
    store.updateLibrary("buddy", { agentProvider: "codex" });
    expect(store.getTemplate("buddy").graphicalSessionEnabled).toBe(true);
    const persisted = JSON.parse(readFileSync(sessionsFile, "utf-8"));
    expect(persisted.every(template => !Object.hasOwn(template, "codexAppServerEnabled")
      && !Object.hasOwn(template, "codeBuddyAcpEnabled") && !Object.hasOwn(template, "openCodeAcpEnabled"))).toBe(true);
  });
  it.each([true, false])("migrates old Codex templates using the legacy setting %s once", (enabled) => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "1", type: "windows", cwd: "C:\\work", agentProvider: "codex" },
      { id: "2", type: "wsl", cwd: "/work", agentProvider: "codex", codexAppServerEnabled: !enabled },
      { id: "3", type: "ssh", cwd: "/work", agentProvider: "codex", sshConfig: { host: "example.com" } }
    ]));
    const store = createSessionStore({
      sessionsFile, getDefaultShell: () => "powershell.exe", getWslShell: () => "wsl.exe",
      safeStorage: createSafeStorageMock(), getLegacyCodexAppServerEnabled: () => enabled
    });
    store.loadLibrary();
    expect(store.getTemplate("1").graphicalSessionEnabled).toBe(enabled);
    expect(store.getTemplate("2").graphicalSessionEnabled).toBe(!enabled);
    expect(store.getTemplate("3").graphicalSessionEnabled).toBe(true);
    expect(JSON.parse(readFileSync(sessionsFile, "utf-8"))[0].graphicalSessionEnabled).toBe(enabled);
    const reopened = createStore(sessionsFile);
    reopened.loadLibrary();
    expect(reopened.getTemplate("1").graphicalSessionEnabled).toBe(enabled);
  });

  it("keeps existing local SSH Codex templates in terminal mode while allowing new App Server templates", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "old", type: "ssh", cwd: "/work", agentProvider: "codex", agentLocation: "local", sshConfig: { host: "example.com" } }
    ]));
    const store = createStore(sessionsFile);
    store.loadLibrary();
    expect(store.getTemplate("old").graphicalSessionEnabled).toBe(false);
    expect(JSON.parse(readFileSync(sessionsFile, "utf-8"))[0].graphicalSessionEnabled).toBe(false);
    store.updateLibrary("old", { graphicalSessionEnabled: true });
    expect(store.getTemplate("old").graphicalSessionEnabled).toBe(true);
    expect(store.normalizeTemplate({ id: "new", type: "ssh", cwd: "/work", agentProvider: "codex", agentLocation: "local", graphicalSessionEnabled: true }).graphicalSessionEnabled).toBe(true);
  });

  it("preserves each Codex template mode through edits, duplication, export, and import", () => {
    const sessionsFile = createTempSessionsFile();
    const store = createStore(sessionsFile);
    store.addToLibrary({ id: "1", type: "windows", cwd: "C:\\work", agentProvider: "codex", graphicalSessionEnabled: false });
    store.updateLibrary("1", { title: "Updated" });
    expect(store.getTemplate("1").graphicalSessionEnabled).toBe(false);
    expect(store.duplicateInLibrary("1").graphicalSessionEnabled).toBe(false);
    const exported = store.exportLibrary();
    expect(exported[0].graphicalSessionEnabled).toBe(false);
    store.importLibrary([exported[0]]);
    expect(store.getLibrary().at(-1).graphicalSessionEnabled).toBe(false);
  });

  it("persists execution permission per Codex template through reload, duplication, export, and import", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "1", type: "windows", cwd: "C:\\work", agentProvider: "codex" },
      { id: "2", type: "wsl", cwd: "/work", agentProvider: "codex", codexExecutionPermission: "invalid" },
      { id: "3", type: "windows", cwd: "C:\\work", agentProvider: "claude", codexExecutionPermission: "fullAccess" },
      { id: "4", type: "ssh", cwd: "/work", agentProvider: "codex", sshConfig: { host: "example.com" } },
      { id: "5", type: "ssh", cwd: "/work", agentProvider: "codex", agentLocation: "local", sshConfig: { host: "example.com" } }
    ]));
    const store = createStore(sessionsFile);
    store.loadLibrary();
    expect(store.getTemplate("1").codexExecutionPermission).toBe("askApproval");
    expect(store.getTemplate("2").codexExecutionPermission).toBe("askApproval");
    expect(store.getTemplate("3").codexExecutionPermission).toBeUndefined();
    expect(store.getTemplate("4").codexExecutionPermission).toBe("askApproval");
    expect(store.getTemplate("5").codexExecutionPermission).toBe("askApproval");
    expect(() => store.setCodexExecutionPermission("1", "invalid")).toThrow("无效");
    expect(() => store.setCodexExecutionPermission("3", "fullAccess")).toThrow("不支持");
    store.setCodexExecutionPermission("5", "fullAccess");
    expect(store.getTemplate("5").codexExecutionPermission).toBe("fullAccess");
    store.setCodexExecutionPermission("1", "fullAccess");
    store.setCodexExecutionPermission("4", "readOnly");
    expect(store.getTemplate("2").codexExecutionPermission).toBe("askApproval");
    store.updateLibrary("1", { title: "Updated" });
    expect(store.duplicateInLibrary("1").codexExecutionPermission).toBe("fullAccess");
    const exported = store.exportLibrary().find(item => item.id === "1");
    store.importLibrary([exported]);
    expect(store.getLibrary().at(-1).codexExecutionPermission).toBe("fullAccess");
    const reopened = createStore(sessionsFile);
    reopened.loadLibrary();
    expect(reopened.getTemplate("1").codexExecutionPermission).toBe("fullAccess");
  });

  it("keeps the previous permission when template persistence fails", () => {
    const sessionsFile = createTempSessionsFile();
    const dataStore = { read: () => [{ id: "1", type: "windows", cwd: "C:\\work", agentProvider: "codex" }],
      write: () => { throw new Error("disk full"); } };
    const store = createSessionStore({ sessionsFile, dataStore,
      getDefaultShell: () => "powershell.exe", getWslShell: () => "wsl.exe" });
    store.loadLibrary();
    expect(() => store.setCodexExecutionPermission("1", "readOnly")).toThrow("disk full");
    expect(store.getTemplate("1").codexExecutionPermission).toBe("askApproval");
  });

  it("persists valid Codex backend metadata when loading saved sessions", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([{
      id: "1",
      type: "windows",
      cwd: "C:\\work",
      agentProvider: "codex",
      codexBackend: "openrouter",
      codexModel: "openai/gpt-5.4",
      codexExperimentalAcknowledged: true
    }]));

    const [session] = createStore(sessionsFile).loadLibrary();
    expect(session).toMatchObject({ codexBackend: "openrouter", codexModel: "openai/gpt-5.4", codexExperimentalAcknowledged: true });
  });

  it("normalizes saved CodeBuddy Codex sessions to OpenAI", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([{
      id: "1",
      type: "wsl",
      cwd: "/work",
      wslDistro: "Ubuntu",
      agentProvider: "codex",
      codexBackend: "codebuddy",
      codexModel: "glm-5.2",
      codexExperimentalAcknowledged: true
    }]));

    const [session] = createStore(sessionsFile).loadLibrary();
    expect(session).toMatchObject({ codexBackend: "openai", modelSource: "native" });
    expect(session.codexModel).toBeUndefined();
    expect(session.codexExperimentalAcknowledged).toBeUndefined();
  });

  it("persists NaraRouter Codex metadata for local sessions", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([{
      id: "1",
      type: "windows",
      cwd: "C:\\work",
      agentProvider: "codex",
      codexBackend: "nararouter",
      codexModel: "gpt-test",
      codexExperimentalAcknowledged: true
    }]));
    const [session] = createStore(sessionsFile).loadLibrary();
    expect(session).toMatchObject({ codexBackend: "nararouter", codexModel: "gpt-test", codexExperimentalAcknowledged: true });
  });

  it("normalizes Codex backend metadata for OpenAI and SSH sessions", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "1", type: "windows", cwd: "C:\\work", agentProvider: "codex", codexBackend: "invalid", codexModel: "ignored", codexExperimentalAcknowledged: true },
      { id: "2", type: "ssh", cwd: "/work", agentProvider: "codex", codexBackend: "openrouter", codexModel: "ignored", codexExperimentalAcknowledged: true, sshConfig: { host: "example.com" } }
    ]));

    const sessions = createStore(sessionsFile).loadLibrary();
    expect(sessions[0]).toMatchObject({ codexBackend: "openai" });
    expect(sessions[0].codexModel).toBeUndefined();
    expect(sessions[0].codexExperimentalAcknowledged).toBeUndefined();
    expect(sessions[1]).toMatchObject({ codexBackend: "openai" });
    expect(sessions[1].codexModel).toBeUndefined();
    expect(sessions[1].codexExperimentalAcknowledged).toBeUndefined();
  });
  it("ignores legacy file roots and normalizes file sorting", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([{ id: "1", title: "Files", type: "windows", cwd: "C:\\terminal", fileRoot: " C:\\repo ", fileSort: { key: "modifiedAt", direction: "desc" } }]));
    const [session] = createStore(sessionsFile).loadLibrary();
    expect(session).toMatchObject({ cwd: "C:\\terminal", fileSort: { key: "modifiedAt", direction: "desc" } });
    expect(session).not.toHaveProperty("fileRoot");
  });

  it("persists the preferred disk mount point only for SSH sessions", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "1", title: "SSH", type: "ssh", cwd: "/srv", sshConfig: { host: "example.com" }, preferredDiskMountPoint: " /data " },
      { id: "2", title: "Local", type: "windows", cwd: "C:\\work", preferredDiskMountPoint: "/ignored" }
    ]));

    const sessions = createStore(sessionsFile).loadLibrary();
    expect(sessions[0].preferredDiskMountPoint).toBe("/data");
    expect(sessions[1].preferredDiskMountPoint).toBeUndefined();

    const store = createStore(sessionsFile);
    store.loadLibrary();
    store.updateLibrary("1", { preferredDiskMountPoint: "/backup" });
    expect(JSON.parse(readFileSync(sessionsFile, "utf-8"))[0].preferredDiskMountPoint).toBe("/backup");
  });

  it("drops legacy Git directory overrides", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "1", title: "Old", type: "windows", cwd: "C:\\old" },
      {
        id: "2",
        title: "Git",
        type: "windows",
        cwd: "C:\\terminal",
        gitCwd: " C:\\repo ",
        gitCwdHistory: ["C:\\repo", "C:\\other"]
      }
    ]));
    const sessions = createStore(sessionsFile).loadLibrary();

    expect(sessions[0]).not.toHaveProperty("gitCwd");
    expect(sessions[0]).not.toHaveProperty("gitCwdHistory");
    expect(sessions[1]).not.toHaveProperty("gitCwd");
    expect(sessions[1]).not.toHaveProperty("gitCwdHistory");
  });

  it("normalizes tags case-insensitively while preserving the first display value", () => {
    expect(normalizeTags([" Work ", "", "work", "SSH", "ssh", null])).toEqual(["Work", "SSH"]);
  });

  it("infers configured working directories from legacy initial commands", () => {
    expect(inferWorkingDirectory("cd C:\\mine\\project && claude", "windows")).toBe("C:\\mine\\project");
    expect(inferWorkingDirectory("cd /d \"C:\\mine\\project space\" && codex", "windows")).toBe("C:\\mine\\project space");
    expect(inferWorkingDirectory("cd /home/me/project && claude", "wsl")).toBe("/home/me/project");
    expect(inferWorkingDirectory("cd /srv/app && claude", "ssh")).toBe("/srv/app");
  });

  it("migrates a legacy home cwd from the initial command", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([{
      id: "3",
      title: "Legacy",
      cwd: homedir(),
      initialCommand: "cd C:\\mine\\project && claude"
    }]), "utf-8");

    const store = createStore(sessionsFile);
    expect(store.loadLibrary()[0].cwd).toBe("C:\\mine\\project");
  });

  it("loads, normalizes, and advances numeric template ids", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "3", title: "Saved", shell: "wsl.exe" }
    ]), "utf-8");

    const store = createStore(sessionsFile);
    const sessions = store.loadLibrary();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "3",
      title: "Saved",
      shell: "wsl.exe",
      type: "wsl"
    });
    expect(sessions[0].cwd).toBeTruthy();
    expect(sessions[0].createdAt).toEqual(expect.any(Number));
    expect(sessions[0].tags).toEqual([]);
    expect(store.createTemplateId()).toBe("4");
  });

  it("preserves explicit Agent providers without inferring legacy CLI commands", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "1", title: "Legacy", initialCommand: "claude" },
      { id: "2", title: "Agent", agentProvider: "codex", initialCommand: "pnpm install" },
      { id: "3", title: "CodeBuddy", agentProvider: "codebuddy" },
      { id: "4", title: "Invalid", agentProvider: "unknown" }
    ]), "utf-8");

    const sessions = createStore(sessionsFile).loadLibrary();
    expect(sessions[0].agentProvider).toBeUndefined();
    expect(sessions[1]).toMatchObject({ agentProvider: "codex", initialCommand: "pnpm install" });
    expect(sessions[2].agentProvider).toBe("codebuddy");
    expect(sessions[3].agentProvider).toBeUndefined();
  });

  it("loads legacy Qwen templates as ordinary terminal sessions", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "1", title: "Legacy Agent", type: "windows", cwd: "C:\\work", agentProvider: "qwen" }
    ]), "utf-8");

    const [session] = createStore(sessionsFile).loadLibrary();
    expect(session).toMatchObject({ id: "1", title: "Legacy Agent", type: "windows", cwd: "C:\\work" });
    expect(session.agentProvider).toBeUndefined();
  });

  it("keeps old SSH Agent templates remote and accepts supported local bridge templates", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "1", title: "Old", type: "ssh", cwd: "/srv/old", agentProvider: "codex", sshConfig: { host: "old.example.com" } },
      { id: "2", title: "Local", type: "ssh", cwd: "/srv/app", agentProvider: "codex", agentLocation: "local", localAgentCwd: " C:\\local work ", sshConfig: { host: "new.example.com" } },
      { id: "3", title: "Unsupported", type: "ssh", cwd: "/srv/app", agentProvider: "claude", agentLocation: "local", localAgentCwd: "C:\\ignored", sshConfig: { host: "new.example.com" } },
      { id: "4", title: "Remote", type: "ssh", cwd: "/srv/app", agentProvider: "codex", agentLocation: "remote", localAgentCwd: "C:\\ignored", sshConfig: { host: "new.example.com" } },
      { id: "5", title: "Windows", type: "ssh", cwd: "C:\\repo", agentProvider: "codex", agentLocation: "local", sshConfig: { host: "win.example.com", remotePlatform: "windows" } },
      { id: "6", title: "Auto", type: "ssh", cwd: "/srv/app", agentProvider: "codex", agentLocation: "local", sshConfig: { host: "auto.example.com", remotePlatform: "auto" } },
      { id: "7", title: "OpenCode Local", type: "ssh", cwd: "/srv/open", agentProvider: "opencode", agentLocation: "local", localAgentCwd: " C:\\opencode-local ", sshConfig: { host: "open.example.com" } },
      { id: "8", title: "CodeBuddy Local", type: "ssh", cwd: "/srv/buddy", agentProvider: "codebuddy", agentLocation: "local", localAgentCwd: " C:\\codebuddy-local ", sshConfig: { host: "buddy.example.com" } }
    ]), "utf-8");

    const sessions = createStore(sessionsFile).loadLibrary();

    expect(sessions[0].agentLocation).toBe("remote");
    expect(sessions[1].agentLocation).toBe("local");
    expect(sessions[1].localAgentCwd).toBe("C:\\local work");
    expect(sessions[2].agentLocation).toBe("remote");
    expect(sessions[2].localAgentCwd).toBeUndefined();
    expect(sessions[3].localAgentCwd).toBeUndefined();
    expect(sessions[4].sshConfig.remotePlatform).toBe("windows");
    expect(sessions[5].sshConfig.remotePlatform).toBeUndefined();
    expect(sessions[6].agentLocation).toBe("local");
    expect(sessions[6].localAgentCwd).toBe("C:\\opencode-local");
    expect(sessions[7].agentLocation).toBe("local");
    expect(sessions[7].localAgentCwd).toBe("C:\\codebuddy-local");
  });

  it("adds, updates, removes, and persists library sessions", () => {
    vi.spyOn(Date, "now").mockReturnValue(12345);
    const sessionsFile = createTempSessionsFile();
    const store = createStore(sessionsFile);

    store.addToLibrary({
      id: "1",
      title: "Work",
      cwd: "C:\\work",
      tags: [" Work ", "work", "Local"]
    });
    store.updateLibrary("1", {
      title: "Work Renamed",
      initialCommand: "pnpm dev",
      cwd: undefined
    });

    expect(store.getTemplate("1")).toMatchObject({
      id: "1",
      title: "Work Renamed",
      shell: "powershell.exe",
      cwd: "C:\\work",
      createdAt: 12345,
      initialCommand: "pnpm dev",
      type: "windows"
    });
    expect(store.getTemplate("1").tags).toEqual(["Work", "Local"]);

    const persisted = JSON.parse(readFileSync(sessionsFile, "utf-8"));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].title).toBe("Work Renamed");

    store.removeFromLibrary("1");

    expect(store.getLibrary()).toEqual([]);
    expect(JSON.parse(readFileSync(sessionsFile, "utf-8"))).toEqual([]);
  });

  it("clears a persisted Agent provider when updated with null", () => {
    const sessionsFile = createTempSessionsFile();
    const store = createStore(sessionsFile);
    store.addToLibrary({ id: "1", title: "Agent", agentProvider: "claude" });

    store.updateLibrary("1", { agentProvider: null });

    expect(store.getTemplate("1").agentProvider).toBeUndefined();
    expect(JSON.parse(readFileSync(sessionsFile, "utf-8"))[0].agentProvider).toBeUndefined();
  });

  it("persists OpenCode and CodeBuddy model sources while excluding SSH", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([
      { id: "1", type: "windows", cwd: "C:\\work", agentProvider: "opencode", modelSource: "openrouter", modelId: "vendor/coder" },
      { id: "2", type: "wsl", cwd: "/work", wslDistro: "Ubuntu", agentProvider: "codebuddy", modelSource: "minimax", modelId: "MiniMax-M2" },
      { id: "3", type: "ssh", cwd: "/work", agentProvider: "opencode", modelSource: "openrouter", modelId: "ignored", sshConfig: { host: "example.com" } }
    ]));
    const store = createStore(sessionsFile);
    const sessions = store.loadLibrary();
    expect(sessions[0]).toMatchObject({ modelSource: "openrouter", modelId: "vendor/coder" });
    expect(sessions[1]).toMatchObject({ modelSource: "minimax", modelId: "MiniMax-M2" });
    expect(sessions[2].modelSource).toBeUndefined();
    store.updateLibrary("1", { modelSource: "native", modelId: null });
    expect(store.getTemplate("1")).toMatchObject({ modelSource: "native" });
    expect(store.getTemplate("1").modelId).toBeUndefined();
  });

  it("persists OpenAI App Server reasoning effort with its template", () => {
    const sessionsFile = createTempSessionsFile();
    const store = createStore(sessionsFile);
    store.addToLibrary({ id: "1", title: "Codex", agentProvider: "codex", codexBackend: "openai" });
    store.updateLibrary("1", { codexAppServerModel: "model-a", codexAppServerEffort: "high" });

    const reloaded = createStore(sessionsFile);
    reloaded.loadLibrary();
    expect(reloaded.getTemplate("1")).toMatchObject({ codexAppServerModel: "model-a", codexAppServerEffort: "high" });
    expect(JSON.parse(readFileSync(sessionsFile, "utf-8"))[0].codexAppServerEffort).toBe("high");
  });

  it("keeps CodeBuddy graphical choices on the original Agent template", () => {
    const sessionsFile = createTempSessionsFile();
    const store = createStore(sessionsFile);
    store.addToLibrary({ id: "1", title: "Codex", agentProvider: "codex" });
    store.updateLibrary("1", { codeBuddyGraphicalOptions: {
      mode: "bypassPermissions", model: "glm-5.3", contextWindow: "1000000", multitask: false
    } });

    const reloaded = createStore(sessionsFile);
    reloaded.loadLibrary();
    expect(reloaded.getTemplate("1")).toMatchObject({ agentProvider: "codex", codeBuddyGraphicalOptions: {
      mode: "bypassPermissions", model: "glm-5.3", contextWindow: "1000000", multitask: false
    } });
    expect(reloaded.duplicateInLibrary("1").codeBuddyGraphicalOptions).toEqual(reloaded.getTemplate("1").codeBuddyGraphicalOptions);
  });

  it("keeps OpenCode graphical choices separately for each saved template", () => {
    const sessionsFile = createTempSessionsFile();
    const store = createStore(sessionsFile);
    store.addToLibrary({ id: "1", title: "Codex", agentProvider: "codex" });
    store.addToLibrary({ id: "2", title: "Other", agentProvider: "opencode" });
    store.updateLibrary("1", { openCodeGraphicalOptions: { mode: "plan", model: "openai/gpt-5.5", effort: "high" } });

    const reloaded = createStore(sessionsFile);
    reloaded.loadLibrary();
    expect(reloaded.getTemplate("1")).toMatchObject({ agentProvider: "codex", openCodeGraphicalOptions: {
      mode: "plan", model: "openai/gpt-5.5", effort: "high"
    } });
    expect(reloaded.getTemplate("2").openCodeGraphicalOptions).toBeUndefined();
    expect(reloaded.duplicateInLibrary("1").openCodeGraphicalOptions).toEqual(reloaded.getTemplate("1").openCodeGraphicalOptions);
  });

  it("returns an empty library for missing or invalid session files", () => {
    const sessionsFile = createTempSessionsFile();
    const store = createStore(sessionsFile);

    expect(store.loadLibrary()).toEqual([]);

    writeFileSync(sessionsFile, "{", "utf-8");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(store.loadLibrary()).toEqual([]);
  });

  it("normalizes and persists SSH sessions with encrypted secrets", () => {
    const sessionsFile = createTempSessionsFile();
    const safeStorage = createSafeStorageMock();
    const store = createStore(sessionsFile, safeStorage);

    store.addToLibrary({
      id: "7",
      type: "ssh",
      title: "Prod",
      cwd: "/srv/app",
      initialCommand: "pnpm dev",
      sshConfig: {
        host: "example.com",
        username: "deploy",
        port: 2222,
        identityFile: "C:\\Users\\tester\\.ssh\\id_ed25519",
        extraArgs: ["-o", "ServerAliveInterval=30"],
        secret: "plain-secret"
      }
    });

    const persisted = JSON.parse(readFileSync(sessionsFile, "utf-8"));
    expect(persisted[0]).toMatchObject({
      id: "7",
      title: "Prod",
      shell: "ssh2",
      type: "ssh",
      cwd: "/srv/app",
      initialCommand: "pnpm dev",
      sshConfig: {
        host: "example.com",
        username: "deploy",
        port: 2222,
        identityFile: "C:\\Users\\tester\\.ssh\\id_ed25519",
        extraArgs: ["-o", "ServerAliveInterval=30"]
      }
    });
    expect(persisted[0].sshConfig.remoteCommand).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain("plain-secret");
    expect(persisted[0].sshConfig.encryptedSecret).toBe(Buffer.from("encrypted:plain-secret").toString("base64"));
    expect(safeStorage.encryptString).toHaveBeenCalledWith("plain-secret");

    expect(store.getLibrary()[0].sshConfig).toMatchObject({
      host: "example.com",
      hasSecret: true
    });
    expect(store.getLibrary()[0].sshConfig.encryptedSecret).toBeUndefined();
    expect(store.decryptSecret(persisted[0].sshConfig.encryptedSecret)).toBe("plain-secret");
  });

  it("migrates legacy SSH remote commands to initial commands and defaults cwd to remote home", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([{
      id: "6",
      title: "Legacy SSH",
      type: "ssh",
      cwd: homedir(),
      sshConfig: {
        host: "example.com",
        remoteCommand: "cd /srv/app && bash"
      }
    }]), "utf-8");

    const store = createStore(sessionsFile);
    const session = store.loadLibrary()[0];

    expect(session.cwd).toBe("~");
    expect(session.initialCommand).toBe("cd /srv/app && bash");
    expect(session.sshConfig.remoteCommand).toBeUndefined();
  });

  it("keeps existing encrypted SSH secret when editing other SSH fields", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([{
      id: "8",
      title: "Old",
      type: "ssh",
      sshConfig: {
        host: "old.example.com",
        encryptedSecret: "ciphertext"
      }
    }]), "utf-8");
    const store = createStore(sessionsFile);
    store.loadLibrary();

    store.updateLibrary("8", {
      title: "New",
      sshConfig: {
        host: "new.example.com"
      }
    });

    expect(store.getTemplate("8")).toMatchObject({
      title: "New",
      sshConfig: {
        host: "new.example.com",
        encryptedSecret: "ciphertext"
      }
    });
  });

  it("clears an existing encrypted SSH secret when requested", () => {
    const sessionsFile = createTempSessionsFile();
    writeFileSync(sessionsFile, JSON.stringify([{
      id: "9",
      title: "Saved",
      type: "ssh",
      sshConfig: {
        host: "example.com",
        encryptedSecret: "ciphertext"
      }
    }]), "utf-8");
    const store = createStore(sessionsFile);
    store.loadLibrary();

    store.updateLibrary("9", {
      sshConfig: {
        host: "example.com",
        clearSecret: true
      }
    });

    expect(store.getTemplate("9").sshConfig.encryptedSecret).toBeUndefined();
    expect(store.getLibrary()[0].sshConfig.hasSecret).toBe(false);
  });

  it("exports library templates with encrypted SSH secrets and without runtime fields", () => {
    const sessionsFile = createTempSessionsFile();
    const store = createStore(sessionsFile);

    store.addToLibrary({
      id: "1",
      title: "Prod",
      type: "ssh",
      term: {},
      buffer: ["runtime"],
      agentStatus: "running",
      sshConfig: {
        host: "example.com",
        encryptedSecret: "ciphertext"
      }
    });

    const exported = store.exportLibrary({ includeEncryptedSecrets: true });

    expect(exported).toHaveLength(1);
    expect(exported[0].sshConfig.encryptedSecret).toBe("ciphertext");
    expect(exported[0].sshConfig.hasSecret).toBeUndefined();
    expect(exported[0].term).toBeUndefined();
    expect(exported[0].buffer).toBeUndefined();
    expect(exported[0].agentStatus).toBeUndefined();
  });

  it("imports sessions by appending normalized templates with new ids", () => {
    const sessionsFile = createTempSessionsFile();
    const store = createStore(sessionsFile);
    store.addToLibrary({
      id: "1",
      title: "Existing",
      cwd: "C:\\existing"
    });

    const result = store.importLibrary([
      {
        id: "1",
        title: "Imported",
        cwd: "C:\\imported",
        tags: [" Work ", "work"]
      }
    ]);

    expect(result.importedCount).toBe(1);
    expect(result.sessions).toHaveLength(2);
    expect(store.getTemplate("1").title).toBe("Existing");
    expect(store.getTemplate("2")).toMatchObject({
      id: "2",
      title: "Imported",
      cwd: "C:\\imported",
      tags: ["Work"]
    });

    const persisted = JSON.parse(readFileSync(sessionsFile, "utf-8"));
    expect(persisted.map((session) => session.id)).toEqual(["1", "2"]);
  });

  it("imports sessions from a legacy array payload shape", () => {
    const sessionsFile = createTempSessionsFile();
    const store = createStore(sessionsFile);
    const legacyPayload = [
      { id: "99", title: "First" },
      { id: "100", title: "Second", type: "wsl", wslDistro: "Ubuntu" }
    ];

    const result = store.importLibrary(legacyPayload);

    expect(result.importedCount).toBe(2);
    expect(store.getLibrary().map((session) => session.title)).toEqual(["First", "Second"]);
    expect(store.getLibrary().map((session) => session.id)).toEqual(["1", "2"]);
  });

  it("rejects invalid imported library payloads with clear errors", () => {
    const sessionsFile = createTempSessionsFile();
    const store = createStore(sessionsFile);

    expect(() => store.importLibrary({ sessions: [] })).toThrow("Imported sessions must be an array.");
    expect(() => store.importLibrary([null])).toThrow("Each imported session must be an object.");
  });

  it("keeps imported SSH encrypted secrets hidden from renderer library data", () => {
    const sessionsFile = createTempSessionsFile();
    const store = createStore(sessionsFile);

    store.importLibrary([{
      id: "5",
      title: "Imported SSH",
      type: "ssh",
      sshConfig: {
        host: "example.com",
        encryptedSecret: "ciphertext"
      }
    }]);

    expect(store.getTemplate("1").sshConfig.encryptedSecret).toBe("ciphertext");
    expect(store.getLibrary()[0].sshConfig).toMatchObject({
      host: "example.com",
      hasSecret: true
    });
    expect(store.getLibrary()[0].sshConfig.encryptedSecret).toBeUndefined();
  });

  it("exposes local usage summaries without exporting or importing usage history", () => {
    const sessionsFile = createTempSessionsFile();
    const templateUsageStore = {
      getSummary: vi.fn((id) => id === "1"
        ? { recentLaunchCount: 3, lastLaunchedAt: 500 }
        : { recentLaunchCount: 0, lastLaunchedAt: undefined }),
      remove: vi.fn()
    };
    const launchTemplateStore = { removeSessionTemplate: vi.fn() };
    const store = createStore(sessionsFile, createSafeStorageMock(), templateUsageStore, launchTemplateStore);
    store.loadLibrary();
    store.importLibrary([{
      id: "external-id",
      title: "Imported",
      type: "windows",
      cwd: "C:\\work",
      recentLaunchCount: 99,
      lastLaunchedAt: 999
    }]);

    expect(store.getLibrary()[0]).toMatchObject({ recentLaunchCount: 3, lastLaunchedAt: 500 });
    expect(store.exportLibrary()[0]).not.toHaveProperty("recentLaunchCount");
    expect(store.exportLibrary()[0]).not.toHaveProperty("lastLaunchedAt");

    const duplicated = store.duplicateInLibrary("1");
    expect(duplicated).not.toHaveProperty("recentLaunchCount");
    expect(store.getLibrary().find((session) => session.id === duplicated.id)).toMatchObject({ recentLaunchCount: 0 });

    store.removeFromLibrary("1");
    expect(templateUsageStore.remove).toHaveBeenCalledWith("1");
    expect(launchTemplateStore.removeSessionTemplate).toHaveBeenCalledWith("1");
  });
});

it("persists warning suppression per template and clears it on duplication", () => {
  const file = createTempSessionsFile();
  const store = createStore(file);
  store.addToLibrary({ id: "a", agentProvider: "codex" });
  store.addToLibrary({ id: "b", agentProvider: "codex" });
  expect(store.getTemplate("a").ignoredCodexConfigWarnings).toEqual([]);
  store.ignoreCodexConfigWarning("a", "warning");
  store.ignoreCodexConfigWarning("a", "warning");
  store.updateLibrary("a", { title: "renamed" });
  expect(store.duplicateInLibrary("a").ignoredCodexConfigWarnings).toEqual([]);
  const reloaded = createStore(file);
  reloaded.loadLibrary();
  expect(reloaded.getTemplate("a").ignoredCodexConfigWarnings).toEqual(["warning"]);
  expect(reloaded.getTemplate("b").ignoredCodexConfigWarnings).toEqual([]);
  expect(() => store.ignoreCodexConfigWarning("missing", "warning")).toThrow();
});

it("does not apply warning suppression when persistence fails", () => {
  let failed = false;
  const store = createSessionStore({ sessionsFile: "unused", getDefaultShell: () => "powershell.exe", getWslShell: () => "wsl.exe",
    dataStore: { write: () => { if (failed) throw new Error("disk unavailable"); } } });
  store.addToLibrary({ id: "a" });
  failed = true;
  expect(() => store.ignoreCodexConfigWarning("a", "warning")).toThrow("disk unavailable");
  expect(store.getTemplate("a").ignoredCodexConfigWarnings).toEqual([]);
});


it("persists named Codex permission profiles and clears them when choosing legacy permissions", () => {
  const file = createTempSessionsFile();
  const store = createStore(file);
  store.loadLibrary();
  store.addToLibrary({ id: "profile-template", type: "windows", cwd: "C:\\project", agentProvider: "codex" });
  const id = store.getLibrary()[0].id;
  store.setCodexPermissionProfile(id, "project");
  const reopened = createStore(file); reopened.loadLibrary();
  expect(reopened.getTemplate(id).codexPermissionProfileId).toBe("project");
  expect(reopened.normalizeTemplate({ type: "windows", agentProvider: "other", codexPermissionProfileId: "project" }).codexPermissionProfileId).toBeUndefined();
  reopened.setCodexExecutionPermission(id, "readOnly");
  expect(reopened.getTemplate(id).codexPermissionProfileId).toBeUndefined();
});


describe("OpenCode directory persistence", () => {
  it("round-trips grants, preserves partial edits, clears and removes provider-specific configuration", () => {
    const file = createTempSessionsFile();
    const store = createStore(file);
    store.addToLibrary({ id: "open", type: "windows", cwd: "C:\\work", agentProvider: "opencode", graphicalSessionEnabled: true, openCodeAdditionalDirectories: [" C:\\shared ", "c:/SHARED/"] });
    expect(createStore(file).loadLibrary()[0].openCodeAdditionalDirectories).toEqual(["C:\\shared"]);
    store.updateLibrary("open", { title: "renamed", openCodeAdditionalDirectories: undefined });
    expect(store.getTemplate("open").openCodeAdditionalDirectories).toEqual(["C:\\shared"]);
    store.updateLibrary("open", { openCodeAdditionalDirectories: [] });
    expect(createStore(file).loadLibrary()[0].openCodeAdditionalDirectories).toEqual([]);
    store.updateLibrary("open", { openCodeAdditionalDirectories: ["C:\\other"] });
    store.updateLibrary("open", { agentProvider: "codex" });
    expect(store.getTemplate("open")).not.toHaveProperty("openCodeAdditionalDirectories");
    expect(JSON.parse(readFileSync(file, "utf8"))[0]).not.toHaveProperty("openCodeAdditionalDirectories");
  });
  it("rejects invalid configuration without changing saved grants", () => {
    const file = createTempSessionsFile(); const store = createStore(file);
    store.addToLibrary({ id: "open", type: "wsl", cwd: "/work", agentProvider: "opencode", openCodeAdditionalDirectories: ["/shared"] });
    expect(() => store.updateLibrary("open", { openCodeAdditionalDirectories: ["relative"] })).toThrow("绝对路径");
    expect(store.getTemplate("open").openCodeAdditionalDirectories).toEqual(["/shared"]);
    expect(createStore(file).loadLibrary()[0].openCodeAdditionalDirectories).toEqual(["/shared"]);
  });
});
