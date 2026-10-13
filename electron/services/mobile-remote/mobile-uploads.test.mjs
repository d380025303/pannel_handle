import { afterEach, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import nodeFs from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { existsSync, readFileSync, promises as fs } from "node:fs";
import uploadsModule from "./mobile-uploads.cjs";

const stores = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(store => store.stop())); });

function fixture() {
  const store = uploadsModule.createMobileUploads();
  stores.push(store);
  const socket = { authenticated: true, graphicalSessionId: "session-1" };
  return { store, socket };
}

function response() {
  return { status: 0, body: "", headersSent: false,
    writeHead(status) { this.status = status; this.headersSent = true; return this; },
    end(body = "") { this.body = body; }, destroy() {} };
}

it("accepts a one-use ticket and preserves the extension for the graphical service", async () => {
  const { store, socket } = fixture();
  const { fileId, url } = store.prepare(socket, "session-1", "thread-1", "photo.png", 3);
  const ticket = new URL(url, "http://localhost").searchParams.get("ticket");
  const reply = response();
  await store.receive(Readable.from([Buffer.from("png")]), reply, fileId, ticket);
  expect(reply.status).toBe(200);
  const [filePath] = store.paths(socket, "session-1", "thread-1", [fileId]);
  expect(filePath.endsWith("photo.png")).toBe(true);
  expect(readFileSync(filePath, "utf8")).toBe("png");
  await store.receive(Readable.from([Buffer.from("png")]), response(), fileId, ticket);
  expect(() => store.paths({ ...socket }, "session-1", "thread-1", [fileId])).toThrow("失效");
  expect(() => store.paths(socket, "session-1", "other", [fileId])).toThrow("失效");
  store.consume([fileId]);
  expect(() => store.paths(socket, "session-1", "thread-1", [fileId])).toThrow("失效");
  store.releaseSession("session-1");
  await store.stop();
  expect(existsSync(filePath)).toBe(false);
});

it("rejects oversized declarations and partial uploads", async () => {
  const { store, socket } = fixture();
  expect(() => store.prepare(socket, "session-1", "thread-1", "large.txt", 10 * 1024 * 1024 + 1)).toThrow("10 MB");
  const { fileId, url } = store.prepare(socket, "session-1", "thread-1", "partial.txt", 4);
  const reply = response();
  await store.receive(Readable.from([Buffer.from("abc")]), reply, fileId,
    new URL(url, "http://localhost").searchParams.get("ticket"));
  expect(reply.status).toBe(400);
  expect(() => store.paths(socket, "session-1", "thread-1", [fileId])).toThrow("失效");
});

it.each(["discard", "disconnect", "session", "expiry", "stop"])("closes real HTTP uploads and file handles on %s", async reason => {
  let time = Date.now();
  const store = uploadsModule.createMobileUploads({ now: () => time });
  stores.push(store);
  const socket = { authenticated: true, graphicalSessionId: "session-1" };
  const writes = [];
  const originalWrite = nodeFs.createWriteStream;
  vi.spyOn(nodeFs, "createWriteStream").mockImplementation((...args) => {
    const stream = originalWrite(...args);
    writes.push(stream);
    return stream;
  });
  const incoming = [], receiving = [], clients = [];
  const server = createServer((request, reply) => {
    const url = new URL(request.url, "http://localhost");
    incoming.push(request);
    receiving.push(store.receive(request, reply, url.pathname.split("/").at(-1), url.searchParams.get("ticket")));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    for (let round = 0; round < (reason === "discard" ? 2 : 1); round++) {
      const ids = [];
      for (let index = 0; index < 10; index++) {
        const { fileId, url } = store.prepare(socket, "session-1", "thread-1", `${round}-${index}.txt`, 4);
        ids.push(fileId);
        const client = httpRequest({ hostname: "127.0.0.1", port: server.address().port, path: url,
          method: "POST", headers: { "Content-Length": 4 }, agent: false });
        client.on("error", () => {});
        clients.push(client);
        client.write("a"); // Leave the real HTTP request open; cancellation must end it.
      }
      await vi.waitFor(() => {
        expect(writes).toHaveLength((round + 1) * 10);
        expect(writes.slice(round * 10).every(stream => stream.pending === false)).toBe(true);
      });
      expect(incoming.filter(request => !request.destroyed)).toHaveLength(10);
      expect(writes.filter(stream => !stream.closed)).toHaveLength(10);
      expect(() => store.prepare(socket, "session-1", "thread-1", "extra.txt", 4)).toThrow("10 个");
      if (reason === "discard") store.discard(socket, ids);
      else if (reason === "disconnect") store.releaseSocket(socket);
      else if (reason === "session") store.releaseSession("session-1");
      else if (reason === "stop") await store.stop();
      else {
        time += 5 * 60 * 1000;
        store.prepare(socket, "session-1", "thread-1", "next.txt", 4); // prepare triggers expiry sweep.
      }
      await vi.waitFor(() => {
        expect(incoming.every(request => request.destroyed)).toBe(true);
        expect(writes.every(stream => stream.closed && stream.fd === null)).toBe(true);
        expect(writes.every(stream => !existsSync(dirname(stream.path)))).toBe(true);
      });
      await Promise.all(receiving);
    }
  } finally {
    for (const client of clients) client.destroy();
    await store.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}, 10_000);

it("rejects payloads exceeding the declared size or the 10 MB limit", async () => {
  const { store, socket } = fixture();
  for (const [size, payload] of [[2, Buffer.from("abc")], [uploadsModule.MAX_FILE_BYTES, Buffer.alloc(uploadsModule.MAX_FILE_BYTES + 1)]]) {
    const { fileId, url } = store.prepare(socket, "session-1", "thread-1", "overflow.txt", size);
    const reply = response();
    await store.receive(Readable.from([payload]), reply, fileId, new URL(url, "http://localhost").searchParams.get("ticket"));
    expect(reply.status).toBe(400);
    expect(reply.body).toContain("大小限制");
    expect(() => store.paths(socket, "session-1", "thread-1", [fileId])).toThrow("失效");
  }
});

it.runIf(process.platform === "win32")("keeps timers running while three locked attachments are removed and awaits retry on stop", async () => {
  const { store, socket } = fixture();
  const ids = [], paths = [];
  for (let index = 0; index < 3; index++) {
    const { fileId, url } = store.prepare(socket, "session-1", "thread-1", `${index}.txt`, 3);
    const reply = response();
    await store.receive(Readable.from([Buffer.from("abc")]), reply, fileId,
      new URL(url, "http://localhost").searchParams.get("ticket"));
    expect(reply.status).toBe(200);
    ids.push(fileId);
    paths.push(...store.paths(socket, "session-1", "thread-1", [fileId]));
  }
  const holder = spawn("powershell.exe", ["-NoProfile", "-Command",
    '$ErrorActionPreference = "Stop"; $handles = @(); try { foreach ($file in (ConvertFrom-Json $env:MOBILE_UPLOAD_LOCK_PATHS)) { $handles += [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read) }; [Console]::WriteLine("ready"); [Console]::ReadLine() | Out-Null } finally { foreach ($handle in $handles) { $handle.Dispose() } }'],
    { env: { ...process.env, MOBILE_UPLOAD_LOCK_PATHS: JSON.stringify(paths) }, windowsHide: true });
  const exited = new Promise(resolve => holder.once("exit", resolve));
  try {
    await new Promise((resolve, reject) => {
      holder.stdout.on("data", chunk => { if (String(chunk).includes("ready")) resolve(); });
      holder.once("error", reject);
      holder.once("exit", code => reject(new Error(`File holder exited: ${code}`)));
    });
    const rm = vi.spyOn(fs, "rm");
    const started = performance.now();
    store.discard(socket, ids);
    for (const id of ids) expect(() => store.paths(socket, "session-1", "thread-1", [id])).toThrow("失效");
    await new Promise(resolve => setTimeout(resolve, 0));
    const timerDelay = performance.now() - started;
    expect(timerDelay).toBeLessThan(500);
    expect(paths.every(existsSync)).toBe(true);
    // Wait for the real Windows failures so the delayed retry is also exercised.
    const failures = await Promise.allSettled(rm.mock.results.slice(0, 3).map(result => result.value));
    expect(failures.every(result => result.status === "rejected")).toBe(true);
    let stopped = false;
    const stopping = store.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(stopped).toBe(false);
    holder.stdin.end("release\n");
    await exited;
    await stopping;
    expect(paths.some(file => existsSync(dirname(file)))).toBe(false);
    expect(rm.mock.calls.length).toBeGreaterThanOrEqual(7);
    for (const id of ids) expect(() => store.paths(socket, "session-1", "thread-1", [id])).toThrow("失效");
    console.info(`Locked attachment cleanup: zero-delay timer ${timerDelay.toFixed(1)} ms`);
  } finally {
    holder.stdin.end();
    holder.kill();
    await exited;
  }
}, 15_000);
