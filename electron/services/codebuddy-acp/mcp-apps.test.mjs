import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { createMcpApps } = createRequire(import.meta.url)("./mcp-apps.cjs");

function fixture() {
  const entry = { threadId: "thread", session: { type: "windows", cwd: os.tmpdir() }, runtime: {}, pastedImages: new Set() };
  const request = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
  const apps = createMcpApps({ current: () => entry, request });
  const item = { id: "tool", toolName: "mcp__test__show" };
  apps.update("thread", item, { toolName: "mcp__test__show", toolResourceUri: "ui://test/app", html: "<h1>Hello</h1>",
    toolResult: { content: [], structuredContent: { count: 1 } } }, {});
  return { apps, entry, item, request };
}
describe("CodeBuddy MCP Apps boundary", () => {
  it("keeps HTML out of broadcast items and retains structured results", () => {
    const { apps, item } = fixture();
    expect(item.mcpApp).toMatchObject({ serverName: "test", resourceUri: "ui://test/app" });
    expect(JSON.stringify(item)).not.toContain("<h1>");
    expect(item.result.structuredContent).toEqual({ count: 1 });
    expect(apps.load("thread", "tool").html).toContain("Hello");
  });
  it("rejects denied grants without calling the server and consumes each grant once", async () => {
    const { apps, request } = fixture();
    const denied = apps.prepare("thread", "tool", "add", { count: 2 });
    expect(await apps.resolve(denied.token, false)).toMatchObject({ isError: true });
    expect(request).not.toHaveBeenCalled();
    await expect(apps.resolve(denied.token, true)).rejects.toThrow("失效");
    const allowed = apps.prepare("thread", "tool", "add", { count: 2 });
    await apps.resolve(allowed.token, true);
    expect(request).toHaveBeenCalledWith(expect.anything(), "_codebuddy.ai/mcpUiCallTool",
      { sessionId: "thread", serverName: "test", toolName: "add", arguments: { count: 2 } }, 120000);
  });
  it("rejects old threads, other servers, expired/disposed grants and WSL", async () => {
    const { apps, entry, request } = fixture();
    expect(() => apps.prepare("thread", "tool", "mcp__other__add", {})).toThrow("工具名称");
    const grant = apps.prepare("thread", "tool", "add", {});
    entry.threadId = "other";
    await expect(apps.resolve(grant.token, true)).rejects.toThrow("对话已失效");
    entry.threadId = "thread";
    const disposed = apps.prepare("thread", "tool", "add", {});
    apps.dispose("thread", "tool");
    await expect(apps.resolve(disposed.token, true)).rejects.toThrow("失效");
    entry.session.type = "wsl";
    expect(() => apps.load("thread", "tool")).toThrow("失效");
    expect(request).not.toHaveBeenCalled();
  });
  it("does not return an in-flight result after switching threads", async () => {
    const { apps, entry, request } = fixture();
    let complete;
    request.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const grant = apps.prepare("thread", "tool", "add", {});
    const result = apps.resolve(grant.token, true);
    entry.threadId = "other";
    complete({ content: [] });
    await expect(result).rejects.toThrow("失效");
  });
  it("rejects oversized metadata and invalid image content", async () => {
    const { apps, item } = fixture();
    expect(() => apps.update("thread", item, { html: "a".repeat(2 * 1024 * 1024) }, {})).toThrow("2 MB");
    await expect(apps.images("thread", "tool", [{ data: Buffer.from("not a png").toString("base64"), mimeType: "image/png" }])).rejects.toThrow("不一致");
  });
  it("writes images only in the session directory and authorizes them for draft attachments", async () => {
    const { apps, entry } = fixture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-mcp-images-"));
    entry.session.cwd = dir;
    try {
      const files = await apps.images("thread", "tool", [{ mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUwAAAABJRU5ErkJggg==" }]);
      expect(files).toHaveLength(1);
      expect(files[0].startsWith(dir + path.sep)).toBe(true);
      expect(entry.pastedImages.has(files[0])).toBe(true);
    } finally {
      if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe test cleanup");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
