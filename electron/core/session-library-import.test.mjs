import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerIpcHandlers } from "./ipc-handlers.cjs";

const limit = 8 * 1024 * 1024;
const directories = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })));
});

async function fixture(content) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "session-import-"));
  directories.push(dir);
  const filePath = path.join(dir, "library.json");
  await fs.promises.writeFile(filePath, content);
  return filePath;
}

function setup(filePath, canceled = false) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const handlers = new Map();
  const sessions = [{ id: "existing" }];
  const sessionStore = { importLibrary: vi.fn(input => ({ importedCount: input.length, sessions: input })) };
  registerIpcHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: vi.fn() },
    terminalManager: { listSessions: () => sessions },
    sessionStore,
    windowManager: { getWindowFromEvent: () => undefined },
    dialog: { showOpenDialog: async () => ({ canceled, filePaths: [filePath] }) }
  });
  return { run: () => handlers.get("sessions:import-library")({}), handlers, sessions, sessionStore };
}

describe("session library import", () => {
  it.each([false, true])("imports real UTF-8 JSON with array wrapper=%s", async wrapped => {
    const sessions = [{ id: "saved", title: "会话😀" }];
    const filePath = await fixture(JSON.stringify(wrapped ? { sessions } : sessions));
    const { run, sessionStore } = setup(filePath);
    await expect(run()).resolves.toEqual({ canceled: false, ok: true, filePath, importedCount: 1, sessions });
    expect(sessionStore.importLibrary).toHaveBeenCalledWith(sessions);
  });

  it.each([64, 128])("rejects a real %i MiB valid JSON before reading or parsing", async mib => {
    const filePath = await fixture('{"sessions":[],"padding":"' + "x".repeat(mib * 1024 * 1024) + '"}');
    const { run, sessionStore } = setup(filePath);
    const read = vi.spyOn(fs, "createReadStream");
    const parse = vi.spyOn(JSON, "parse");
    const result = await run();
    expect(result).toEqual({ canceled: false, ok: false, error: expect.stringContaining("8 MiB") });
    expect(read).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(sessionStore.importLibrary).not.toHaveBeenCalled();
  });

  it("accepts exactly the byte limit", async () => {
    const base = '{"sessions":[],"padding":""}';
    const { run } = setup(await fixture(base.replace('""', '"' + "x".repeat(limit - Buffer.byteLength(base)) + '"')));
    await expect(run()).resolves.toMatchObject({ ok: true, importedCount: 0 });
  });

  it("rejects growth after stat before parsing and closes the stream", async () => {
    const { run, sessionStore } = setup("growing.json");
    vi.spyOn(fs.promises, "stat").mockResolvedValue({ size: 2 });
    let closed = false;
    vi.spyOn(fs, "createReadStream").mockImplementation(() => (async function* () {
      try { yield Buffer.alloc(limit); yield Buffer.from("x"); }
      finally { closed = true; }
    })());
    await expect(run()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("8 MiB") });
    expect(closed).toBe(true);
    expect(sessionStore.importLibrary).not.toHaveBeenCalled();
  });

  it("processes a timer and another IPC while reading is pending", async () => {
    const { run, handlers, sessions, sessionStore } = setup("delayed.json");
    vi.spyOn(fs.promises, "stat").mockResolvedValue({ size: 2 });
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    let started;
    const reading = new Promise(resolve => { started = resolve; });
    vi.spyOn(fs, "createReadStream").mockImplementation(() => (async function* () {
      started();
      await pending;
      yield Buffer.from("[]");
    })());
    const importing = run();
    await reading;
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(await handlers.get("sessions:list")({})).toEqual(sessions);
      expect(sessionStore.importLibrary).not.toHaveBeenCalled();
    } finally { release(); }
    await expect(importing).resolves.toMatchObject({ ok: true, importedCount: 0 });
  });

  it.each(['{', '{"sessions":{}}'])("returns an error without importing invalid content %s", async content => {
    const { run, sessionStore } = setup(await fixture(content));
    await expect(run()).resolves.toMatchObject({ canceled: false, ok: false, error: expect.any(String) });
    expect(sessionStore.importLibrary).not.toHaveBeenCalled();
  });

  it("preserves cancellation and filesystem errors", async () => {
    const canceled = setup("missing.json", true);
    await expect(canceled.run()).resolves.toEqual({ canceled: true });
    const missing = setup(path.join(os.tmpdir(), "missing-session-library", "library.json"));
    await expect(missing.run()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("ENOENT") });
    expect(missing.sessionStore.importLibrary).not.toHaveBeenCalled();
  });
});
