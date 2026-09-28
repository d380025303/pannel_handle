import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import httpModule from "./mobile-http.cjs";

const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it("checks the live bind address and origin for both HTTP and websocket upgrades", () => {
  let address = "192.168.1.1";
  const { verifyRequestHost } = httpModule.createMobileHttpHandler({
    accessStore: { getConfig: () => ({ port: 43123 }) }, getAddress: () => address, getStaticRoot: () => "."
  });
  expect(verifyRequestHost({ headers: { host: "192.168.1.1:43123", origin: "http://192.168.1.1:43123" } })).toBe(true);
  expect(verifyRequestHost({ headers: { host: "192.168.1.1:43123", origin: "http://evil.example" } })).toBe(false);
  expect(verifyRequestHost({ headers: { host: "127.0.0.1:43123", origin: "http://127.0.0.1:43123" } })).toBe(true);
  expect(verifyRequestHost({ headers: { host: "127.0.0.1:43123", origin: "http://evil.example" } })).toBe(false);
  expect(verifyRequestHost({ headers: { host: "localhost:43123" } })).toBe(false);
  address = "192.168.1.3";
  expect(verifyRequestHost({ headers: { host: "192.168.1.1:43123" } })).toBe(false);
  expect(verifyRequestHost({ headers: { host: "192.168.1.3:43123" } })).toBe(true);
});

it("serves HEAD metadata, blocks writes and returns unavailable when the static build is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-mobile-http-"));
  roots.push(root);
  const { handleHttp } = httpModule.createMobileHttpHandler({
    accessStore: { getConfig: () => ({ port: 43123 }) }, getAddress: () => "192.168.1.1", getStaticRoot: () => root
  });
  const request = (method, url = "/") => {
    const response = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
    handleHttp({ method, url, headers: { host: "192.168.1.1:43123" } }, response);
    return response;
  };
  expect(request("GET").writeHead).toHaveBeenCalledWith(503, expect.any(Object));
  fs.writeFileSync(path.join(root, "index.html"), "test");
  const head = request("HEAD");
  expect(head.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" }));
  expect(head.end).toHaveBeenCalledWith();
  expect(head.setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
  expect(request("POST").writeHead).toHaveBeenCalledWith(405, { Allow: "GET, HEAD" });
  expect(request("GET", "/health").end).toHaveBeenCalledWith(JSON.stringify({ ok: true, protocolVersion: 7 }));
});

it("routes only same-origin upload POST requests to the ticket handler", () => {
  const uploads = { receive: vi.fn(async () => undefined) };
  const { handleHttp } = httpModule.createMobileHttpHandler({
    accessStore: { getConfig: () => ({ port: 43123 }) }, getAddress: () => "192.168.1.1",
    getStaticRoot: () => ".", uploads
  });
  const id = "12345678-1234-1234-1234-123456789abc";
  const response = () => ({ setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() });
  const allowed = { method: "POST", url: `/api/v1/upload/${id}?ticket=secret`,
    headers: { host: "192.168.1.1:43123", origin: "http://192.168.1.1:43123" } };
  handleHttp(allowed, response());
  expect(uploads.receive).toHaveBeenCalledWith(allowed, expect.any(Object), id, "secret");
  const denied = response();
  handleHttp({ ...allowed, headers: { ...allowed.headers, origin: "http://evil.example" } }, denied);
  expect(denied.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
  expect(uploads.receive).toHaveBeenCalledTimes(1);
});

it("routes download GET requests through the ticket handler", () => {
  const files = { download: vi.fn(async () => undefined) };
  const { handleHttp } = httpModule.createMobileHttpHandler({
    accessStore: { getConfig: () => ({ port: 43123 }) }, getAddress: () => "192.168.1.1",
    getStaticRoot: () => ".", files
  });
  const id = "12345678-1234-1234-1234-123456789abc";
  const request = { method: "GET", url: `/api/v1/download/${id}?ticket=secret`,
    headers: { host: "192.168.1.1:43123", origin: "http://192.168.1.1:43123" } };
  const response = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
  handleHttp(request, response);
  expect(files.download).toHaveBeenCalledWith(request, response, id, "secret");
  handleHttp({ ...request, headers: { ...request.headers, origin: "http://evil.example" } }, response);
  expect(files.download).toHaveBeenCalledTimes(1);
});
