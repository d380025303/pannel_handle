import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createMcpConfigService } = require("./mcp-config-service.cjs");

const roots = [];

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "pannel-handle-mcp-"));
  roots.push(root);
  const homeDir = path.join(root, "home");
  const projectDirectory = path.join(root, "project");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(projectDirectory, { recursive: true });
  const sessions = new Map([
    ["windows", { id: "windows", type: "windows", cwd: projectDirectory }],
    ["wsl", { id: "wsl", type: "wsl", cwd: "/srv/app" }]
  ]);
  const service = createMcpConfigService({
    homeDir,
    terminalManager: { getSession: (id) => sessions.get(id) }
  });
  return { root, homeDir, projectDirectory, service };
}

function stdioDraft(name, overrides = {}) {
  return {
    name,
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "example-mcp"],
    argsMasked: false,
    cwd: "",
    url: "",
    urlMasked: false,
    bearerTokenEnvVar: "",
    env: [],
    headers: [],
    ...overrides
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("mcp-config-service", () => {
  it("creates and edits Codex user servers without rewriting unrelated TOML", () => {
    const { homeDir, service } = setup();
    const filePath = path.join(homeDir, ".codex", "config.toml");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "# keep this comment\nmodel = \"gpt-test\"\n\n[mcp_servers.old]\ncommand = \"old\"\ncustom_flag = true\n", "utf-8");

    const first = service.list({ provider: "codex", scope: "user" });
    const saved = service.save({
      provider: "codex",
      scope: "user",
      originalName: "old",
      expectedVersion: first.version,
      draft: stdioDraft("renamed", { env: [{ key: "TOKEN", value: "secret", masked: false }], startupTimeoutSec: 12 })
    });

    expect(saved.status).toBe("saved");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("# keep this comment");
    expect(content).toContain('model = "gpt-test"');
    expect(content).toContain("custom_flag = true");
    expect(content).toContain("[mcp_servers.renamed]");
    expect(content).not.toContain("[mcp_servers.old]");
    expect(existsSync(`${filePath}.pannel-handle.bak`)).toBe(true);
  });

  it("redacts and reveals Codex environment and URL secrets with version checks", () => {
    const { homeDir, service } = setup();
    const filePath = path.join(homeDir, ".codex", "config.toml");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, [
      "[mcp_servers.local]",
      'command = "node"',
      'args = ["--token", "arg-secret"]',
      "[mcp_servers.local.env]",
      'TOKEN = "top-secret"',
      "",
      "[mcp_servers.remote]",
      'url = "https://example.test/mcp?token=hidden"',
      ""
    ].join("\n"), "utf-8");

    const listed = service.list({ provider: "codex", scope: "user" });
    const local = listed.servers.find((server) => server.name === "local");
    const remote = listed.servers.find((server) => server.name === "remote");
    expect(local.env).toEqual([{ key: "TOKEN", value: "", masked: true, hasValue: true }]);
    expect(local).toMatchObject({ args: [], argsMasked: true });
    expect(remote).toMatchObject({ url: "", urlMasked: true });
    expect(service.reveal({ provider: "codex", scope: "user", name: "local", field: "env", key: "TOKEN", expectedVersion: listed.version }))
      .toEqual({ status: "revealed", value: "top-secret" });
    expect(service.reveal({ provider: "codex", scope: "user", name: "local", field: "args", expectedVersion: listed.version }))
      .toEqual({ status: "revealed", value: '["--token","arg-secret"]' });
    expect(service.reveal({ provider: "codex", scope: "user", name: "remote", field: "url", expectedVersion: "stale" }))
      .toEqual({ status: "conflict" });
  });

  it("manages CodeBuddy user, private project, and shared project scopes independently", () => {
    const { homeDir, projectDirectory, service } = setup();
    const requests = [
      { provider: "codebuddy", scope: "user" },
      { provider: "codebuddy", scope: "project-local", sessionId: "windows" },
      { provider: "codebuddy", scope: "project", sessionId: "windows" }
    ];

    for (const request of requests) {
      const listed = service.list(request);
      const result = service.save({
        ...request,
        expectedVersion: listed.version,
        draft: stdioDraft("same-name", { enabled: request.scope !== "project-local" })
      });
      expect(result.status).toBe("saved");
    }

    expect(service.list(requests[0]).servers).toHaveLength(1);
    expect(service.list(requests[1]).servers[0]).toMatchObject({ name: "same-name", enabled: false });
    expect(service.list(requests[2]).servers[0]).toMatchObject({ name: "same-name", enabled: true });
    const userDocument = JSON.parse(readFileSync(path.join(homeDir, ".codebuddy.json"), "utf-8"));
    expect(userDocument.mcpServers["same-name"].command).toBe("npx");
    expect(Object.values(userDocument.projects)[0].disabledMcpServers).toEqual(["same-name"]);
    expect(JSON.parse(readFileSync(path.join(projectDirectory, ".mcp.json"), "utf-8")).mcpServers["same-name"]).toBeTruthy();
  });

  it("preserves unknown CodeBuddy fields and masked secrets while updating known fields", () => {
    const { homeDir, service } = setup();
    const filePath = path.join(homeDir, ".codebuddy.json");
    writeFileSync(filePath, JSON.stringify({
      model: "keep-me",
      mcpServers: {
        api: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer secret" }, vendorOption: 7 }
      },
      disabledMcpServers: []
    }, null, 2), "utf-8");

    const listed = service.list({ provider: "codebuddy", scope: "user" });
    const draft = { ...listed.servers[0], enabled: false };
    const result = service.save({ provider: "codebuddy", scope: "user", originalName: "api", expectedVersion: listed.version, draft });

    expect(result.status).toBe("saved");
    const document = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(document.model).toBe("keep-me");
    expect(document.mcpServers.api.vendorOption).toBe(7);
    expect(document.mcpServers.api.headers.Authorization).toBe("Bearer secret");
    expect(document.disabledMcpServers).toEqual(["api"]);
  });

  it("rejects conflicts, duplicate names, invalid JSON, and non-Windows project targets", () => {
    const { homeDir, service } = setup();
    const initial = service.list({ provider: "codebuddy", scope: "user" });
    expect(service.save({ provider: "codebuddy", scope: "user", expectedVersion: "stale", draft: stdioDraft("one") }))
      .toEqual({ status: "conflict" });
    service.save({ provider: "codebuddy", scope: "user", expectedVersion: initial.version, draft: stdioDraft("one") });
    const current = service.list({ provider: "codebuddy", scope: "user" });
    expect(() => service.save({ provider: "codebuddy", scope: "user", expectedVersion: current.version, draft: stdioDraft("one") }))
      .toThrow(/already exists/i);
    expect(() => service.list({ provider: "codex", scope: "project", sessionId: "wsl" })).toThrow(/Windows sessions only/);
    writeFileSync(path.join(homeDir, ".codebuddy.json"), "{", "utf-8");
    expect(() => service.list({ provider: "codebuddy", scope: "user" })).toThrow(/Invalid CodeBuddy MCP JSON/);
  });

  it("removes only the requested server", () => {
    const { homeDir, service } = setup();
    const filePath = path.join(homeDir, ".codebuddy.json");
    writeFileSync(filePath, JSON.stringify({
      mcpServers: { one: { command: "one" }, two: { command: "two" } },
      disabledMcpServers: ["one", "two"]
    }, null, 2), "utf-8");
    const listed = service.list({ provider: "codebuddy", scope: "user" });
    const result = service.remove({ provider: "codebuddy", scope: "user", name: "one", expectedVersion: listed.version });
    expect(result.status).toBe("removed");
    const document = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(Object.keys(document.mcpServers)).toEqual(["two"]);
    expect(document.disabledMcpServers).toEqual(["two"]);
  });
});
