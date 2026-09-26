import { afterEach, expect, it } from "vitest";
import { Readable } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import uploadsModule from "./mobile-uploads.cjs";

const stores = [];
afterEach(() => { for (const store of stores.splice(0)) store.stop(); });

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
