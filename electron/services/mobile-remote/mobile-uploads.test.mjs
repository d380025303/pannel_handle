import { afterEach, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
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
