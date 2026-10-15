import fs from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import { inflateRawSync } from "node:zlib";
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

it("scans drives asynchronously with bounded concurrency and keeps the event loop responsive", async () => {
  let active = 0;
  let maximum = 0;
  let completed = 0;
  const stat = vi.fn(async drive => {
    maximum = Math.max(maximum, ++active);
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      if (drive === "C:\\" || drive === "Z:\\") return { isDirectory: () => true };
      if (drive === "D:\\") return { isDirectory: () => false };
      throw Object.assign(new Error("Unavailable drive"), { code: "ENOENT" });
    } finally { active--; completed++; }
  });
  const statSync = vi.fn(() => { throw new Error("Synchronous drive check"); });
  const files = filesModule.createMobileFiles({ fsApi: { statSync, promises: { stat } } });
  const timer = new Promise(resolve => setTimeout(() => resolve(completed), 0));
  const message = new Promise(resolve => setImmediate(() => resolve(completed)));
  const listing = files.list(null);
  expect(await timer).toBeLessThan(26);
  expect(await message).toBeLessThan(26);
  expect(await listing).toEqual({ path: null, entries: ["C:\\", "Z:\\"].map(root =>
    ({ name: root, path: root, type: "drive", size: null })) });
  expect(stat).toHaveBeenCalledTimes(26);
  expect(statSync).not.toHaveBeenCalled();
  expect(maximum).toBe(4);
  expect(active).toBe(0);
  // Refresh each request so removed or newly mounted disks affect path validation.
  stat.mockImplementation(async () => { throw new Error("Unavailable drive"); });
  expect(await files.list(null)).toEqual({ path: null, entries: [] });
  await expect(files.prepare({ authenticated: true }, "C:\\note.txt")).rejects.toThrow(/本地磁盘/);
});

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

it.each([1, 6, 12])("validates shared ancestors once per large listing at depth %i", async depth => {
  const ancestors = Array.from({ length: depth }, (_, index) => path.win32.join("C:\\", ...Array.from({ length: index + 1 }, (_, part) => `folder-${part}`)));
  const directory = ancestors.at(-1);
  const names = Array.from({ length: 1000 }, (_, index) => `file-${index}.txt`);
  const directoryInfo = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
  const fileInfo = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 10 };
  const fsApi = {
    driveStat: vi.fn(drive => {
      if (drive === "C:\\") return directoryInfo;
      throw Object.assign(new Error("Unavailable drive"), { code: "ENOENT" });
    }),
    promises: {
      readdir: vi.fn(async () => names),
      lstat: vi.fn(async () => fileInfo),
      realpath: vi.fn(async target => target),
      stat: vi.fn(async target => /^[A-Z]:\\$/.test(target) ? fsApi.driveStat(target) : target === directory ? directoryInfo : fileInfo)
    }
  };
  const files = filesModule.createMobileFiles({ fsApi });
  const expected = names.map(name => ({ name, path: path.win32.join(directory, name), type: "file", size: 10 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  expect(await files.list(directory)).toEqual({ path: directory, entries: expected });
  expect(fsApi.driveStat).toHaveBeenCalledTimes(26);
  expect(fsApi.promises.lstat).toHaveBeenCalledTimes(1000 + depth);
  for (const ancestor of ancestors) {
    expect(fsApi.promises.lstat.mock.calls.filter(([target]) => target === ancestor)).toHaveLength(1);
  }
  expect(fsApi.promises.realpath).toHaveBeenCalledTimes(1001);

  fsApi.promises.lstat.mockClear();
  fsApi.promises.lstat.mockImplementation(async target => {
    if (target === path.win32.join(directory, names[3])) throw Object.assign(new Error("Unreadable"), { code: "EACCES" });
    return { ...fileInfo, isSymbolicLink: () => [names[0], names[2]].some(name => target === path.win32.join(directory, name)) };
  });
  fsApi.promises.realpath.mockImplementation(async target =>
    target === path.win32.join(directory, names[1]) ? "D:\\outside.txt" : target);
  const filtered = await files.list(directory);
  expect(filtered.entries).toEqual(expected.filter(entry => !names.slice(0, 4).includes(entry.name)));
  for (const ancestor of ancestors) {
    expect(fsApi.promises.lstat.mock.calls.filter(([target]) => target === ancestor)).toHaveLength(1);
  }
  expect(fsApi.driveStat).toHaveBeenCalledTimes(52);
  await expect(files.list(path.win32.join(directory, names[0]))).rejects.toThrow(/符号链接/);
  await expect(files.list(path.win32.join(directory, names[1]))).rejects.toThrow(/重定向/);
  await expect(files.list("D:\\outside")).rejects.toThrow(/本地磁盘/);
  fsApi.promises.lstat.mockImplementation(async target => ({ ...fileInfo, isSymbolicLink: () => target === ancestors[0] }));
  await expect(files.list(directory)).rejects.toThrow(/符号链接/);
});

it.each([{ depth: 1, nested: false }, { depth: 1, nested: true }, { depth: 8, nested: false }])(
  "validates shared ancestors once per folder download at depth $depth (nested: $nested)", async ({ depth, nested }) => {
  const directory = path.win32.join("C:\\", ...Array.from({ length: depth }, (_, index) => index ? `level-${index}` : "folder"));
  const childDirectory = path.win32.join(directory, "nested");
  const names = Array.from({ length: 1000 }, (_, index) => `file-${index}.txt`);
  const unsafeNames = depth === 8 ? [] : ["symlink", "junction", "redirected"];
  const directoryInfo = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
  const fileInfo = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 4 };
  const fsApi = {
    driveStat: vi.fn(drive => {
      if (drive === "C:\\") return directoryInfo;
      throw Object.assign(new Error("Unavailable drive"), { code: "ENOENT" });
    }),
    promises: {
      readdir: vi.fn(async target => nested && target === directory ? ["nested"] : [...names, ...unsafeNames]),
      lstat: vi.fn(async target => ({ ...fileInfo,
        isSymbolicLink: () => ["symlink", "junction"].includes(path.win32.basename(target)) })),
      realpath: vi.fn(async target => path.win32.basename(target) === "redirected" ? "D:\\outside.txt" : target),
      stat: vi.fn(async target => /^[A-Z]:\\$/.test(target) ? fsApi.driveStat(target) : [directory, childDirectory].includes(target) ? directoryInfo : fileInfo)
    }
  };
  const files = filesModule.createMobileFiles({ fsApi });
  const socket = { authenticated: true, remoteAddress: "192.168.1.2" };
  const { url } = await files.prepare(socket, directory);
  fsApi.driveStat.mockClear();
  fsApi.promises.lstat.mockClear();
  fsApi.promises.realpath.mockClear();
  const archived = vi.spyOn(Archiver.prototype, "file").mockImplementation(function (target, options) {
    return this.append(Buffer.from("test"), { ...options });
  });
  try {
    const result = await receive(files, socket, url);
    expect(result.status).toBe(200);
    expect(fsApi.driveStat).toHaveBeenCalledTimes(26);
    expect(fsApi.promises.lstat).toHaveBeenCalledTimes(depth + (nested ? 1 : 0) + names.length + unsafeNames.length);
    expect(fsApi.promises.lstat.mock.calls.filter(([target]) => target === directory)).toHaveLength(1);
    expect(archived).toHaveBeenCalledTimes(1000);
    const parent = nested ? childDirectory : directory;
    for (const name of names) {
      expect(archived).toHaveBeenCalledWith(path.win32.join(parent, name),
        { name: `${path.win32.basename(directory)}/${nested ? "nested/" : ""}${name}` });
      expect(fsApi.promises.lstat).toHaveBeenCalledWith(path.win32.join(parent, name));
      expect(fsApi.promises.realpath).toHaveBeenCalledWith(path.win32.join(parent, name));
    }
    for (const name of unsafeNames) {
      expect(fsApi.promises.lstat).toHaveBeenCalledWith(path.win32.join(parent, name));
      expect(archived.mock.calls.some(([target]) => target === path.win32.join(parent, name))).toBe(false);
    }
    await expect(files.prepare(socket, "D:\\outside.txt")).rejects.toThrow(/本地磁盘/);
    await expect(files.prepare(socket, path.win32.join(parent, "junction"))).rejects.toThrow(/符号链接/);
    await expect(files.prepare(socket, path.win32.join(parent, "symlink"))).rejects.toThrow(/符号链接/);
    await expect(files.prepare(socket, path.win32.join(parent, "redirected"))).rejects.toThrow(/重定向/);
  } finally {
    archived.mockRestore();
    files.stop();
  }
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

it("supersedes only the same connection's listing and stops pending entry checks", async () => {
  const directory = "C:\\";
  const names = Array.from({ length: 100 }, (_, index) => `file-${index}.txt`);
  const directoryInfo = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
  const fileInfo = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 10 };
  let resume;
  let entered;
  let blocked = true;
  const gate = new Promise(resolve => { resume = resolve; });
  const paused = new Promise(resolve => { entered = resolve; });
  const fsApi = { promises: {
    readdir: vi.fn(async () => names),
    lstat: vi.fn(async () => {
      if (blocked) {
        if (fsApi.promises.lstat.mock.calls.length === 8) entered();
        await gate;
      }
      return fileInfo;
    }),
    realpath: vi.fn(async target => target),
    stat: vi.fn(async target => target === directory ? directoryInfo : fileInfo)
  } };
  const files = filesModule.createMobileFiles({ fsApi, getRoots: () => [directory] });
  const socket = { authenticated: true };
  const old = files.list(directory, socket);
  await paused;
  const latest = files.list(directory, socket);
  blocked = false;
  resume();
  expect(await old).toBeUndefined();
  expect((await latest).entries).toHaveLength(100);
  // Eight issued lstat calls finish, but the old scan does no further validation.
  expect(fsApi.promises.lstat).toHaveBeenCalledTimes(108);
  expect(fsApi.promises.realpath).toHaveBeenCalledTimes(102);
  expect(fsApi.promises.stat).toHaveBeenCalledTimes(102);
  expect(fsApi.promises.readdir).toHaveBeenCalledTimes(2);

  const other = { authenticated: true };
  const results = await Promise.all([files.list(directory, socket), files.list(directory, other)]);
  expect(results.map(result => result.entries.length)).toEqual([100, 100]);
  files.stop();
});

it("reduces ten concurrent delayed listings to one complete scan", async () => {
  vi.useFakeTimers();
  try {
    const directory = "C:\\";
    const names = Array.from({ length: 100 }, (_, index) => `file-${index}.txt`);
    const info = target => ({ isDirectory: () => target === directory, isFile: () => target !== directory,
      isSymbolicLink: () => false, size: 10 });
    let operations = 0;
    let active = 0;
    let maximum = 0;
    const delayed = operation => async target => {
      operations++;
      maximum = Math.max(maximum, ++active);
      try {
        await new Promise(resolve => setTimeout(resolve, 5));
        return operation(target);
      } finally { active--; }
    };
    const files = filesModule.createMobileFiles({ getRoots: () => [directory], fsApi: { promises: {
      readdir: delayed(() => names), lstat: delayed(info), realpath: delayed(target => target), stat: delayed(info)
    } } });
    const socket = { authenticated: true };
    const baseline = files.list(directory, socket);
    await vi.runAllTimersAsync();
    expect((await baseline).entries).toHaveLength(100);
    expect(operations).toBe(303);
    expect(maximum).toBe(8);
    operations = 0;
    maximum = 0;
    const requests = Array.from({ length: 10 }, () => files.list(directory, socket));
    await vi.runAllTimersAsync();
    const results = await Promise.all(requests);
    expect(results.slice(0, 9)).toEqual(Array(9).fill(undefined));
    expect(results[9].entries).toHaveLength(100);
    expect(operations).toBe(303);
    expect(maximum).toBe(8);
    expect(active).toBe(0);
    operations = 0;
    maximum = 0;
    const staggered = [];
    for (let index = 0; index < 10; index++) {
      staggered.push(files.list(directory, socket));
      // Supersede each request after it has issued its first eight entry checks.
      await vi.advanceTimersByTimeAsync(15);
    }
    await vi.runAllTimersAsync();
    const staggeredResults = await Promise.all(staggered);
    expect(staggeredResults.slice(0, 9)).toEqual(Array(9).fill(undefined));
    expect(staggeredResults[9].entries).toHaveLength(100);
    expect(operations).toBe(9 * 11 + 303);
    expect(maximum).toBe(9);
    expect(active).toBe(0);
    files.stop();
  } finally { vi.useRealTimers(); }
});

it("keeps an active download independent of replacement listings", async () => {
  const source = new PassThrough();
  const fsApi = { ...fs, createReadStream: () => source };
  const { root, files, socket } = fixture(undefined, fsApi);
  const target = path.join(root, "note.txt");
  fs.writeFileSync(target, "hello phone");
  const { url } = await files.prepare(socket, target);
  const downloading = receive(files, socket, url);
  await vi.waitFor(() => expect(source.listenerCount("data")).toBeGreaterThan(0));
  const listings = await Promise.all([files.list(null, socket), files.list(null, socket)]);
  expect(listings[0]).toBeUndefined();
  expect(listings[1].entries).toHaveLength(1);
  expect(source.destroyed).toBe(false);
  source.end("hello phone");
  expect((await downloading).body.toString()).toBe("hello phone");
  files.stop();
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
  fs.symlinkSync(path.join(folder, "nested"), path.join(folder, "junction"), "junction");
  const { url } = await files.prepare(socket, folder);
  const result = await receive(files, socket, url);
  expect(result.status).toBe(200);
  expect(result.headers["Content-Type"]).toBe("application/zip");
  expect(result.body.subarray(0, 2).toString()).toBe("PK");
  expect(result.body.includes(Buffer.from("folder/nested/note.txt"))).toBe(true);
  expect(result.body.includes(Buffer.from("folder/junction/"))).toBe(false);
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

it.each(["resume", "close", "disconnect", "stop", "error", "warning"])(
  "bounds 10,000 real Archiver entries under blocked output and handles %s", async action => {
    const fsApi = { ...fs, promises: { ...fs.promises } };
    const { root, files, socket } = fixture(undefined, fsApi);
    const source = path.join(root, "source.txt");
    fs.writeFileSync(source, "archive payload");
    const largeSource = path.join(root, "large.bin");
    const payload = randomBytes(4096);
    fs.writeFileSync(largeSource, payload);
    const names = Array.from({ length: 10_000 }, (_, index) => `file-${index}.txt`);
    const fileInfo = fs.statSync(source);
    fsApi.promises.readdir = vi.fn(async () => names);
    fsApi.promises.lstat = async target => target === root ? fs.lstatSync(root) : fileInfo;
    fsApi.promises.realpath = async target => target;
    fsApi.promises.stat = async target => target === root ? fs.statSync(root) : fileInfo;
    const { url } = await files.prepare(socket, root);
    let archive;
    let submitted = 0;
    let completed = 0;
    let maximum = 0;
    let statMaximum = 0;
    const originalFile = Archiver.prototype.file;
    const spy = vi.spyOn(Archiver.prototype, "file").mockImplementation(function (target, options) {
      if (!archive) {
        archive = this;
        this.on("entry", () => { completed++; });
        this.on("warning", () => { completed++; });
      }
      submitted++;
      maximum = Math.max(maximum, submitted - completed);
      const result = originalFile.call(this, action === "warning" && submitted === 1 ? path.join(root, "missing") : largeSource, options);
      statMaximum = Math.max(statMaximum, this._statQueue.length());
      return result;
    });
    const output = new PassThrough({ highWaterMark: 1 });
    output.writeHead = vi.fn();
    const parsed = new URL(url, "http://localhost");
    const downloading = files.download({ socket: { remoteAddress: socket.remoteAddress } }, output,
      path.basename(parsed.pathname), parsed.searchParams.get("ticket"));
    try {
      await vi.waitFor(() => {
        expect(submitted - completed).toBe(32);
        expect(output.writableNeedDrain).toBe(true);
      });
      await vi.waitFor(async () => {
        const before = submitted;
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(submitted).toBe(before);
      }, { timeout: 5000 });
      const paused = submitted;
      expect(submitted).toBeLessThan(10_000);
      if (action === "resume" || action === "warning") {
        const chunks = [];
        const ended = new Promise(resolve => output.on("end", resolve));
        output.on("data", chunk => chunks.push(chunk));
        await downloading;
        await ended;
        expect(submitted).toBe(10_000);
        const count = action === "warning" ? 9999 : 10_000;
        const zip = Buffer.concat(chunks);
        const end = zip.length - 22;
        expect(zip.readUInt32LE(end)).toBe(0x06054b50);
        expect(Number(zip.readBigUInt64LE(end - 20 - 56 + 32))).toBe(count);
        let offset = Number(zip.readBigUInt64LE(end - 20 - 56 + 48));
        const archivedNames = [];
        for (let index = 0; index < count; index++) {
          expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
          const local = zip.readUInt32LE(offset + 42);
          expect(zip.readUInt32LE(local)).toBe(0x04034b50);
          const dataOffset = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
          const compressedSize = zip.readUInt32LE(offset + 20);
          const content = inflateRawSync(zip.subarray(dataOffset, dataOffset + compressedSize));
          expect(content.equals(payload)).toBe(true);
          const nameLength = zip.readUInt16LE(offset + 28);
          archivedNames.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString());
          offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
        }
        expect(archivedNames.sort()).toEqual((action === "warning" ? names.slice(1) : names).map(name => `${path.basename(root)}/${name}`).sort());
      } else {
        if (action === "close") output.destroy();
        else if (action === "stop") files.stop();
        else if (action === "error") archive.emit("error", new Error("archive failed"));
        else files.releaseSocket(socket);
        await Promise.race([downloading, new Promise((_, reject) => setTimeout(() => reject(new Error("cancellation hung")), 1000))]);
        expect(output.destroyed).toBe(true);
        expect(submitted).toBe(paused);
        expect(archive._statQueue.length()).toBe(0);
      }
      expect(maximum).toBeLessThanOrEqual(32);
      expect(statMaximum).toBeLessThanOrEqual(32);
    } finally {
      files.stop();
      spy.mockRestore();
    }
  }, 30_000
);


it.each(["disconnect", "stop", "authentication", "reauthenticate", "readdir"])(
  "cancels a 10,000-entry listing on %s without claiming more entries", async reason => {
    const directory = "C:\\folder";
    const names = Array.from({ length: 10_000 }, (_, index) => `file-${index}.txt`);
    const directoryInfo = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
    const fileInfo = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 10 };
    let resume;
    let entered;
    let blocked = true;
    const gate = new Promise(resolve => { resume = resolve; });
    const paused = new Promise(resolve => { entered = resolve; });
    const fsApi = { promises: {
      readdir: vi.fn(async () => {
        if (reason === "readdir" && blocked) { entered(); await gate; }
        return names;
      }),
      lstat: vi.fn(async target => {
        if (target !== directory && blocked && reason !== "readdir") {
          if (fsApi.promises.lstat.mock.calls.length === 9) entered();
          await gate;
        }
        return target === directory ? directoryInfo : fileInfo;
      }),
      realpath: vi.fn(async target => target),
      stat: vi.fn(async target => target === directory ? directoryInfo : fileInfo)
    } };
    const files = filesModule.createMobileFiles({ fsApi, getRoots: () => ["C:\\"] });
    const socket = { authenticated: true };
    const listing = files.list(directory, socket);
    await paused;
    const counts = [fsApi.promises.lstat, fsApi.promises.realpath, fsApi.promises.stat].map(fn => fn.mock.calls.length);
    if (reason === "stop") files.stop();
    else if (reason === "authentication") socket.authenticated = false;
    else {
      files.releaseSocket(socket);
      if (reason === "reauthenticate") socket.authenticated = true;
    }
    blocked = false;
    resume();
    expect(await listing).toBeUndefined();
    expect([fsApi.promises.lstat, fsApi.promises.realpath, fsApi.promises.stat].map(fn => fn.mock.calls.length)).toEqual(counts);
    expect(counts[0]).toBe(reason === "readdir" ? 1 : 9);
    const connected = { authenticated: true };
    expect((await files.list(directory, connected)).entries).toHaveLength(10_000);
    files.stop();
  }
);

it("searches nested names case-insensitively and rejects invalid roots", async () => {
  const { root, files, socket } = fixture();
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "nested", "REPORT中文.txt"), "hello");
  fs.writeFileSync(path.join(root, "other.txt"), "report");
  const result = await files.search(root, "report中文", socket, "s1");
  expect(result.entries.map(entry => entry.name)).toEqual(["REPORT中文.txt"]);
  expect(result.reason).toBe("complete");
  await expect(files.search(path.dirname(root), "report", socket, "s2")).rejects.toThrow(/本地磁盘/);
  await expect(files.search(root, " ", socket, "s3")).rejects.toThrow();
});

it("cancels searches explicitly and on disconnect", async () => {
  const { root, files, socket } = fixture();
  const first = files.search(root, "report", socket, "s1");
  files.cancelSearch(socket, "s1");
  expect(await first).toBeUndefined();
  const second = files.search(root, "report", socket, "s2");
  files.releaseSocket(socket);
  expect(await second).toBeUndefined();
});

it("bounds results and reports truncation", async () => {
  const { root, files, socket } = fixture();
  for (let i = 0; i < 501; i++) fs.writeFileSync(path.join(root, `match-${i}`), "");
  const result = await files.search(root, "match", socket, "s1");
  expect(result.entries).toHaveLength(500);
  expect(result.reason).toBe("result-limit");
});

it("reports inaccessible descendants and skips links", async () => {
  let denied;
  const fsApi = { ...fs, promises: { ...fs.promises, opendir: async directory => {
    if (directory === denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return fs.promises.opendir(directory);
  } } };
  const { root, files, socket } = fixture(() => Date.now(), fsApi);
  denied = path.join(root, "private");
  fs.mkdirSync(denied);
  fs.writeFileSync(path.join(denied, "hidden.txt"), "");
  fs.symlinkSync(denied, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  const result = await files.search(root, ".txt", socket, "s1");
  expect(result.entries).toEqual([]);
  expect(result.skipped).toBe(2);
  await expect(files.search(denied, "hidden", socket, "s2")).rejects.toThrow("denied");
});

it("returns a timeout and replaces previous searches", async () => {
  let time = 0;
  const { root, files, socket } = fixture(() => { time += 15000; return time; });
  expect((await files.search(root, "report", socket, "s1")).reason).toBe("timeout");
  const first = files.search(root, "report", socket, "s2");
  const next = files.search(root, "other", socket, "s3");
  expect(await first).toBeUndefined();
  expect((await next).reason).toBe("timeout");
});

it("bounds scanned entries even when nothing matches", async () => {
  const info = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
  let root;
  const fsApi = { ...fs, promises: {
    lstat: async () => info,
    realpath: async value => value,
    stat: async value => value === root ? { ...info, isDirectory: () => true } : info,
    opendir: async function* () { for (let i = 0; i < 50001; i++) yield { name: "other.txt" }; }
  } };
  const data = fixture(() => 0, fsApi);
  root = data.root;
  const result = await data.files.search(root, "missing", data.socket, "s1");
  expect(result.reason).toBe("scan-limit");
  expect(result.entries).toEqual([]);
});
