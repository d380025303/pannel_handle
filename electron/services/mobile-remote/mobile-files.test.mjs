import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import Archiver from "archiver/lib/core.js";
import { afterEach, expect, it, vi } from "vitest";
import filesModule from "./mobile-files.cjs";

const roots = [];
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.length = 0; });

function fixture(now = () => Date.now(), fsApi = fs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-mobile-files-"));
  roots.push(root);
  const files = filesModule.createMobileFiles({ fsApi, pathApi: path, getRoots: () => [root], now });
  const socket = { authenticated: true, remoteAddress: "192.168.1.2" };
  return { root, files, socket };
}

async function receive(files, socket, url, remoteAddress = socket.remoteAddress) {
  const parsed = new URL(url, "http://localhost");
  const output = new PassThrough();
  const chunks = [];
  let status;
  let headers;
  output.writeHead = (code, values) => { status = code; headers = values; };
  output.on("data", chunk => chunks.push(chunk));
  const finished = new Promise(resolve => output.on("end", resolve));
  await files.download({ socket: { remoteAddress } }, output, path.basename(parsed.pathname), parsed.searchParams.get("ticket"));
  await finished;
  return { status, headers, body: Buffer.concat(chunks) };
}

it("lists local directories and excludes links and inaccessible paths", async () => {
  const { root, files } = fixture();
  fs.mkdirSync(path.join(root, "folder"));
  fs.writeFileSync(path.join(root, "note.txt"), "hello");
  let linked = true;
  try { fs.symlinkSync(path.join(root, "folder"), path.join(root, "link"), "junction"); }
  catch (error) { if (error.code === "EPERM") linked = false; else throw error; }
  expect((await files.list(null)).entries).toEqual([{ name: root, path: root, type: "drive", size: null }]);
  expect((await files.list(root)).entries.map(entry => entry.name)).toEqual(["folder", "note.txt"]);
  if (linked) await expect(files.list(path.join(root, "link"))).rejects.toThrow(/符号链接/);
  await expect(files.list(path.resolve(root, ".."))).rejects.toThrow(/本地磁盘/);
});

it("probes drives once per large listing while validating every child", async () => {
  const directory = "C:\\folder";
  const names = Array.from({ length: 1000 }, (_, index) => `file-${index}.txt`);
  const directoryInfo = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
  const fileInfo = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 10 };
  const fsApi = {
    statSync: vi.fn(drive => {
      if (drive === "C:\\") return directoryInfo;
      throw Object.assign(new Error("Unavailable drive"), { code: "ENOENT" });
    }),
    promises: {
      readdir: vi.fn(async () => names),
      lstat: vi.fn(async () => fileInfo),
      realpath: vi.fn(async target => target),
      stat: vi.fn(async target => target === directory ? directoryInfo : fileInfo)
    }
  };
  const files = filesModule.createMobileFiles({ fsApi });
  const expected = names.map(name => ({ name, path: path.win32.join(directory, name), type: "file", size: 10 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  expect(await files.list(directory)).toEqual({ path: directory, entries: expected });
  expect(fsApi.statSync).toHaveBeenCalledTimes(26);
  expect(fsApi.promises.lstat).toHaveBeenCalledTimes(2001);
  expect(fsApi.promises.realpath).toHaveBeenCalledTimes(1001);

  fsApi.promises.lstat.mockImplementation(async target => ({
    ...fileInfo, isSymbolicLink: () => target === path.win32.join(directory, names[0])
  }));
  fsApi.promises.realpath.mockImplementation(async target =>
    target === path.win32.join(directory, names[1]) ? "D:\\outside.txt" : target);
  const filtered = await files.list(directory);
  expect(filtered.entries).toEqual(expected.filter(entry => !names.slice(0, 2).includes(entry.name)));
  expect(fsApi.statSync).toHaveBeenCalledTimes(52);
  await expect(files.list(path.win32.join(directory, names[0]))).rejects.toThrow(/符号链接/);
  await expect(files.list(path.win32.join(directory, names[1]))).rejects.toThrow(/重定向/);
  await expect(files.list("D:\\outside")).rejects.toThrow(/本地磁盘/);
});

it.each([0, 3, 25])("bounds concurrent path checks and filters failed entries with %i children", async count => {
  const directory = "C:\\folder";
  const names = Array.from({ length: count }, (_, index) => `entry-${index}`);
  const info = target => ({
    isSymbolicLink: () => target === path.win32.join(directory, "entry-0"),
    isDirectory: () => target === directory || target.endsWith("entry-4"),
    isFile: () => target !== directory && !target.endsWith("entry-4"),
    size: 10
  });
  let active = 0;
  let maximum = 0;
  const delayed = operation => async target => {
    maximum = Math.max(maximum, ++active);
    try {
      await new Promise(resolve => setTimeout(resolve, target.endsWith("entry-3") ? 2 : 0));
      return operation(target);
    } finally { active--; }
  };
  const files = filesModule.createMobileFiles({ getRoots: () => ["C:\\"], fsApi: { promises: {
    readdir: async () => names,
    lstat: delayed(target => {
      if (target.endsWith("entry-2")) throw Object.assign(new Error("Unreadable"), { code: "EACCES" });
      return info(target);
    }),
    realpath: delayed(target => target.endsWith("entry-1") ? "D:\\outside" : target),
    stat: delayed(info)
  } } });
  const expected = names.slice(3).map(name => ({ name, path: path.win32.join(directory, name),
    type: name === "entry-4" ? "directory" : "file", size: name === "entry-4" ? null : 10 }))
    .sort((a, b) => (a.type === "directory" ? 0 : 1) - (b.type === "directory" ? 0 : 1) || a.name.localeCompare(b.name));
  expect(await files.list(directory)).toEqual({ path: directory, entries: expected });
  expect(maximum).toBe(count ? Math.min(8, count) : 1);
  expect(active).toBe(0);
});

it("streams a file once to the authenticated phone", async () => {
  const { root, files, socket } = fixture();
  const target = path.join(root, "note.txt");
  fs.writeFileSync(target, "hello phone");
  const { url } = await files.prepare(socket, target);
  expect((await receive(files, socket, url, "192.168.1.9")).status).toBe(403);
  const result = await receive(files, socket, url);
  expect(result.status).toBe(200);
  expect(result.body.toString()).toBe("hello phone");
  expect(result.headers["Content-Disposition"]).toContain("note.txt");
  expect((await receive(files, socket, url)).status).toBe(403);
});

it("downloads nested folders as a ZIP and invalidates tickets on disconnect", async () => {
  const { root, files, socket } = fixture();
  const folder = path.join(root, "folder");
  fs.mkdirSync(path.join(folder, "nested"), { recursive: true });
  fs.writeFileSync(path.join(folder, "nested", "note.txt"), "zip content");
  const { url } = await files.prepare(socket, folder);
  const result = await receive(files, socket, url);
  expect(result.status).toBe(200);
  expect(result.headers["Content-Type"]).toBe("application/zip");
  expect(result.body.subarray(0, 2).toString()).toBe("PK");
  expect(result.body.includes(Buffer.from("folder/nested/note.txt"))).toBe(true);
  const next = await files.prepare(socket, folder);
  files.releaseSocket(socket);
  expect((await receive(files, socket, next.url)).status).toBe(403);
});

it.each(["disconnect", "reauthenticate", "authentication", "close", "stop", "validation error"])(
  "cancels a download during path validation on %s", async reason => {
    const fsApi = { ...fs, promises: { ...fs.promises }, createReadStream: vi.fn(fs.createReadStream) };
    const { root, files, socket } = fixture(undefined, fsApi);
    const target = path.join(root, "note.txt");
    fs.writeFileSync(target, "private content");
    const { url } = await files.prepare(socket, target);
    let resume;
    let entered;
    const paused = new Promise(resolve => { entered = resolve; });
    fsApi.promises.lstat = async value => {
      entered();
      await new Promise(resolve => { resume = resolve; });
      if (reason === "validation error") throw new Error("validation failed");
      return fs.promises.lstat(value);
    };
    const parsed = new URL(url, "http://localhost");
    const output = new PassThrough();
    output.writeHead = vi.fn();
    const chunks = [];
    output.on("data", chunk => chunks.push(chunk));
    const closed = new Promise(resolve => output.on("close", resolve));
    const downloading = files.download({ socket: { remoteAddress: socket.remoteAddress } }, output,
      path.basename(parsed.pathname), parsed.searchParams.get("ticket"));
    await paused;
    if (reason === "close") output.destroy();
    else if (reason === "stop") files.stop();
    else {
      socket.authenticated = false;
      if (reason !== "authentication") files.releaseSocket(socket);
      if (reason === "reauthenticate") socket.authenticated = true;
    }
    resume();
    await downloading;
    await closed;
    expect(output.writeHead).not.toHaveBeenCalled();
    expect(chunks).toEqual([]);
    expect(fsApi.createReadStream).not.toHaveBeenCalled();
  }
);

it("rejects expired tickets and files removed after preparation", async () => {
  let at = 1000;
  const { root, files, socket } = fixture(() => at);
  const target = path.join(root, "temporary.txt");
  fs.writeFileSync(target, "temporary");
  const expired = await files.prepare(socket, target);
  at += 60_001;
  expect((await receive(files, socket, expired.url)).status).toBe(403);
  const removed = await files.prepare(socket, target);
  fs.rmSync(target);
  expect((await receive(files, socket, removed.url)).status).toBe(404);
});

it.each(["disconnect", "close", "stop"])(
  "stops folder traversal after a paused directory read on %s", async reason => {
    const fsApi = { ...fs, promises: { ...fs.promises } };
    const { root, files, socket } = fixture(undefined, fsApi);
    const folder = path.join(root, "folder");
    fs.mkdirSync(folder);
    for (let index = 0; index < 100; index++) fs.mkdirSync(path.join(folder, `child-${index}`));
    const { url } = await files.prepare(socket, folder);
    let resume;
    let entered;
    const paused = new Promise(resolve => { entered = resolve; });
    fsApi.promises.readdir = vi.fn(async target => {
      entered();
      await new Promise(resolve => { resume = resolve; });
      return fs.promises.readdir(target);
    });
    fsApi.promises.lstat = vi.fn(fs.promises.lstat);
    fsApi.promises.realpath = vi.fn(fs.promises.realpath);
    fsApi.promises.stat = vi.fn(fs.promises.stat);
    const finalize = vi.spyOn(Archiver.prototype, "finalize");
    const parsed = new URL(url, "http://localhost");
    const output = new PassThrough();
    output.writeHead = vi.fn();
    const closed = new Promise(resolve => output.on("close", resolve));
    try {
      const downloading = files.download({ socket: { remoteAddress: socket.remoteAddress } }, output,
        path.basename(parsed.pathname), parsed.searchParams.get("ticket"));
      await paused;
      expect(fsApi.promises.readdir).toHaveBeenCalledTimes(1);
      const counts = [fsApi.promises.lstat, fsApi.promises.realpath, fsApi.promises.stat]
        .map(method => method.mock.calls.length);
      if (reason === "close") output.destroy();
      else if (reason === "stop") files.stop();
      else files.releaseSocket(socket);
      await closed;
      expect(output.destroyed).toBe(true);
      resume();
      await downloading;
      expect(fsApi.promises.readdir).toHaveBeenCalledTimes(1);
      expect([fsApi.promises.lstat, fsApi.promises.realpath, fsApi.promises.stat]
        .map(method => method.mock.calls.length)).toEqual(counts);
      expect(finalize).not.toHaveBeenCalled();
    } finally {
      resume?.();
      files.stop();
      finalize.mockRestore();
    }
  }
);
