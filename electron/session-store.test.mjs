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

function createStore(sessionsFile, safeStorage = createSafeStorageMock()) {
  return createSessionStore({
    sessionsFile,
    getDefaultShell: () => "powershell.exe",
    getWslShell: () => "wsl.exe",
    safeStorage
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
  it("preserves Git directory state and defaults old sessions to no override", () => {
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

    expect(sessions[0]).toMatchObject({ gitCwd: undefined, gitCwdHistory: [] });
    expect(sessions[1]).toMatchObject({
      gitCwd: "C:\\repo",
      gitCwdHistory: ["C:\\repo", "C:\\other"]
    });
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
});
