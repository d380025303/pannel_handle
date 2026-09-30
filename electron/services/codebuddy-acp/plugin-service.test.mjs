import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const require = createRequire(import.meta.url);
const { createCodeBuddyPluginService } = require("./plugin-service.cjs");

function fixture(type = "windows") {
  const calls = [];
  const commands = [];
  let failReload = false;
  const session = { id: "session", type, runtimeMode: "app-server", agentProvider: "codebuddy" };
  const transport = {
    pluginRuntime: vi.fn(() => ({ cwd: "C:\\work", shell: "powershell.exe", before: "", environment: {} })),
    pluginRequest: vi.fn(async (_id, method, route, body) => {
      calls.push({ method, route, body });
      if (route === "/api/v1/plugins/reload" && failReload) throw new Error("reload failed");
      if (route === "/api/v1/plugins/marketplaces") return { data: [{ name: "example", autoUpdate: false }, { name: "built-in", isBuiltIn: true }] };
      if (route.endsWith("/browse")) return { data: { plugins: [{ name: "formatter", description: "Format files" }] } };
      return { data: {} };
    })
  };
  function spawnProcess(_executable, args) {
    commands.push(Buffer.from(args.at(-1), "base64").toString("utf16le"));
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    queueMicrotask(() => {
      child.stdout.end("[]");
      child.emit("close", 0);
    });
    return child;
  }
  const service = createCodeBuddyPluginService({ terminalManager: { getSession: () => session }, graphicalService: transport, spawnProcess });
  return { service, session, calls, commands, transport, failReload: () => { failReload = true; } };
}

describe("CodeBuddy plugin management", () => {
  it("uses the selected CLI scope and reloads the active session", async () => {
    const { service, commands, calls } = fixture();
    await service.install("session", "formatter", "example", "project");
    expect(commands[0]).toContain("'install' 'formatter@example' '--scope' 'project'");
    expect(calls).toContainEqual({ method: "POST", route: "/api/v1/plugins/reload", body: {} });
  });

  it("keeps a saved change visible when reload fails", async () => {
    const value = fixture(); value.failReload();
    const result = await value.service.disable("session", "formatter", "example", "local");
    expect(result.reloadError).toBe("reload failed");
    expect(value.commands[0]).toContain("'disable' 'formatter@example' '--scope' 'local'");
  });

  it("rejects unsupported environments, scopes, and built-in marketplace changes", async () => {
    await expect(fixture("wsl").service.list("session")).rejects.toThrow("仅 Windows");
    await expect(fixture().service.install("session", "formatter", "example", "managed")).rejects.toThrow("范围无效");
    await expect(fixture().service.removeMarketplace("session", "built-in")).rejects.toThrow("内置");
    await expect(fixture().service.setAutoUpdate("session", "built-in", false)).resolves.toHaveProperty("marketplaces");
  });

  it("browses markets and sends named marketplace operations", async () => {
    const { service, calls } = fixture();
    const result = await service.list("session");
    expect(result.available).toContainEqual({ name: "formatter", description: "Format files", marketplaceName: "example" });
    await service.addMarketplace("session", "owner/repo", "team", true);
    expect(calls).toContainEqual({ method: "POST", route: "/api/v1/plugins/marketplaces",
      body: { source: "owner/repo", name: "team", autoUpdate: true } });
    await service.setAutoUpdate("session", "example", true);
    expect(calls).toContainEqual({ method: "POST", route: "/api/v1/plugins/marketplaces/auto-update",
      body: { marketplace: "example", autoUpdate: true } });
  });
});
