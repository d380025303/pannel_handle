import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createSessionStore } = require("./session-store.cjs");

let tempDirs = [];

function createTempSessionsFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "pannel-handle-sessions-"));
  tempDirs.push(dir);
  return path.join(dir, "sessions.json");
}

function createStore(sessionsFile) {
  return createSessionStore({
    sessionsFile,
    getDefaultShell: () => "powershell.exe",
    getWslShell: () => "wsl.exe"
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
    expect(store.createTemplateId()).toBe("4");
  });

  it("adds, updates, removes, and persists library sessions", () => {
    vi.spyOn(Date, "now").mockReturnValue(12345);
    const sessionsFile = createTempSessionsFile();
    const store = createStore(sessionsFile);

    store.addToLibrary({
      id: "1",
      title: "Work",
      cwd: "C:\\work"
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
});
