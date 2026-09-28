import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import filesModule from "./mobile-files.cjs";

const roots = [];
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.length = 0; });

function fixture(now = () => Date.now()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-mobile-files-"));
  roots.push(root);
  const files = filesModule.createMobileFiles({ pathApi: path, getRoots: () => [root], now });
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
