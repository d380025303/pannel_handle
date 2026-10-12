import { afterEach, describe, expect, it, vi } from "vitest";
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
  it.each(["explicit", "runtime"])("reads and saves SSH local Codex project configuration in the %s workspace", (workspaceType) => {
    const { homeDir, projectDirectory } = setup();
    const session = { id: "ssh-local", type: "ssh", agentLocation: "local", runtimeMode: "app-server",
      agentProvider: "codex", cwd: "/srv/app",
      ...(workspaceType === "explicit" ? { localAgentCwd: projectDirectory } : {}) };
    const getWorkspaceCwd = vi.fn(() => projectDirectory);
    const service = createMcpConfigService({ homeDir,
      terminalManager: { getSession: () => session }, graphicalService: { getWorkspaceCwd } });
    const filePath = path.join(projectDirectory, ".codex", "config.toml");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '[mcp_servers.demo]\ncommand = "old"\n', "utf-8");
    const target = { provider: "codex", scope: "project", sessionId: session.id };

    const first = service.list(target);
    expect(first.path).toBe(filePath);
    expect(first.projectDirectory).toBe(projectDirectory);
    expect(first.servers[0]).toMatchObject({ name: "demo", command: "old" });
    const saved = service.save({ ...target, originalName: "demo", expectedVersion: first.version,
      draft: stdioDraft("demo", { command: "new" }) });
    expect(saved.status).toBe("saved");
    expect(saved.document.path).toBe(filePath);
    expect(saved.document.servers[0]).toMatchObject({ name: "demo", command: "new" });
    expect(readFileSync(filePath, "utf-8")).toContain('command = "new"');
    expect(getWorkspaceCwd).toHaveBeenCalledWith(session.id);
  });

  it("reads and updates SSH Codex MCP configuration in the active session environment", async () => {
    const { homeDir } = setup();
    const session = { id: "ssh", type: "ssh", agentLocation: "remote", runtimeMode: "app-server",
      agentProvider: "codex", cwd: "/srv/app" };
    let text = 'model = "keep"\n[mcp_servers.demo]\ncommand = "old"\n';
    const exec = vi.fn(async (_id, command) => {
      if (command.includes("base64 <")) return Buffer.from(text).toString("base64");
      if (command.includes("printf %s")) return "/srv/app/.codex/config.toml";
      return "";
    });
    const sshFileSystem = { mkdir: vi.fn(async () => {}), put: vi.fn(async (_id, content) => { text = content.toString(); }),
      remove: vi.fn(async () => {}) };
    const service = createMcpConfigService({ homeDir,
      terminalManager: { getSession: () => session },
      graphicalService: { getWorkspaceCwd: () => "/srv/app" },
      environmentService: { resolve: () => ({}) },
      sshAgentTransport: { exec }, sshFileSystem });
    const target = { provider: "codex", scope: "project", sessionId: "ssh" };
    const first = await service.list(target);
    expect(first.servers[0]).toMatchObject({ name: "demo", command: "old" });
    const saved = await service.save({ ...target, originalName: "demo", expectedVersion: first.version,
      draft: stdioDraft("demo", { command: "new", enabled: false }) });
    expect(saved.status).toBe("saved");
    expect(saved.document.servers[0]).toMatchObject({ command: "new", enabled: false });
    expect(exec.mock.calls.some(([, command]) => command.includes("sha256sum") && command.includes(".pannel-handle.bak"))).toBe(true);
    expect(sshFileSystem.put).toHaveBeenCalledOnce();
  });
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

  it("manages OpenCode v2 user and project MCP files while preserving JSONC content", () => {
    const { homeDir, projectDirectory, service } = setup();
    const userPath = path.join(homeDir, ".config", "opencode", "opencode.jsonc");
    mkdirSync(path.dirname(userPath), { recursive: true });
    writeFileSync(userPath, '{\n  // keep this comment\n  "model": "keep",\n  "mcp": { "servers": { "existing": { "type": "local", "command": ["node", "server.js"], "disabled": true } } }\n}\n');
    const user = service.list({ provider: "opencode", scope: "user" });
    expect(user.path).toBe(userPath);
    expect(user.servers[0]).toMatchObject({ name: "existing", command: "node", args: ["server.js"], enabled: false });
    const saved = service.save({ provider: "opencode", scope: "user", expectedVersion: user.version,
      draft: stdioDraft("second", { cwd: "C:\\tools", startupTimeoutSec: 3, toolTimeoutSec: 8,
        env: [{ key: "TOKEN", value: "secret", masked: false }] }) });
    expect(saved.status).toBe("saved");
    const userText = readFileSync(userPath, "utf8");
    expect(userText).toContain("// keep this comment");
    expect(userText).toContain('"model": "keep"');
    expect(JSON.parse(userText.replace(/\/\/ keep this comment/, "")).mcp.servers.second).toMatchObject({
      type: "local", command: ["npx", "-y", "example-mcp"], cwd: "C:\\tools",
      environment: { TOKEN: "secret" }, disabled: false, timeout: { startup: 3000, execution: 8000 }
    });
    const project = service.list({ provider: "opencode", scope: "project", sessionId: "windows" });
    expect(project.path).toBe(path.join(projectDirectory, "opencode.json"));
    expect(project.servers).toEqual([]);
  });

  it("copies Codex stdio and HTTP servers into OpenCode without exposing or altering source secrets", () => {
    const { homeDir, service } = setup();
    const codexPath = path.join(homeDir, ".codex", "config.toml");
    const openCodePath = path.join(homeDir, ".config", "opencode", "opencode.json");
    mkdirSync(path.dirname(codexPath), { recursive: true });
    mkdirSync(path.dirname(openCodePath), { recursive: true });
    const codexText = '[mcp_servers.local]\ncommand = "node"\nargs = ["--token", "secret"]\nenabled = false\nstartup_timeout_sec = 2.5\ntool_timeout_sec = 6\n[mcp_servers.local.env]\nTOKEN = "private"\n\n[mcp_servers.remote]\nurl = "https://example.test/mcp"\nbearer_token_env_var = "MCP_TOKEN"\n[mcp_servers.remote.env_http_headers]\nX-Client = "CLIENT_ID"\n';
    writeFileSync(codexPath, codexText);
    writeFileSync(openCodePath, '{\n  "model": "keep"\n}\n');
    for (const name of ["local", "remote"]) {
      const source = service.list({ provider: "codex", scope: "user" });
      const destination = service.list({ provider: "opencode", scope: "user" });
      const result = service.copy({ source: { provider: "codex", scope: "user" }, name,
        expectedSourceVersion: source.version, expectedDestinationVersion: destination.version });
      expect(result.status).toBe("copied");
    }
    expect(readFileSync(codexPath, "utf8")).toBe(codexText);
    const servers = JSON.parse(readFileSync(openCodePath, "utf8")).mcp.servers;
    expect(servers.local).toMatchObject({ type: "local", command: ["node", "--token", "secret"],
      environment: { TOKEN: "private" }, disabled: true, timeout: { startup: 2500, execution: 6000 } });
    expect(servers.remote).toMatchObject({ type: "remote", url: "https://example.test/mcp", oauth: false,
      headers: { Authorization: "Bearer {env:MCP_TOKEN}", "X-Client": "{env:CLIENT_ID}" } });
    expect(JSON.parse(readFileSync(openCodePath, "utf8")).model).toBe("keep");
  });

  it("copies Codex tool allowlists and approval overrides into OpenCode permissions", () => {
    const { homeDir, service } = setup();
    const codexPath = path.join(homeDir, ".codex", "config.toml");
    const openCodePath = path.join(homeDir, ".config", "opencode", "opencode.jsonc");
    mkdirSync(path.dirname(codexPath), { recursive: true });
    mkdirSync(path.dirname(openCodePath), { recursive: true });
    writeFileSync(codexPath, '[mcp_servers."docs.server"]\ncommand = "node"\nenabled_tools = ["read", "write.file"]\ndefault_tools_approval_mode = "prompt"\n[mcp_servers."docs.server".tools."write.file"]\napproval_mode = "approve"\n');
    writeFileSync(openCodePath, '{\n  // preserve\n  "model": "keep",\n  "permissions": [\n    // keep existing permission\n    { "action": "read", "resource": "*", "effect": "allow" }\n  ]\n}\n');
    const source = service.list({ provider: "codex", scope: "user" });
    const destination = service.list({ provider: "opencode", scope: "user" });
    const result = service.copy({ source: { provider: "codex", scope: "user" }, name: "docs.server",
      expectedSourceVersion: source.version, expectedDestinationVersion: destination.version });
    expect(result).toMatchObject({ status: "copied", permissionsCopied: true });
    const text = readFileSync(openCodePath, "utf8");
    expect(text).toContain("// preserve");
    expect(text).toContain("// keep existing permission");
    const document = JSON.parse(text.replace(/\/\/ preserve/, "").replace(/\/\/ keep existing permission/, ""));
    expect(document.model).toBe("keep");
    expect(document.mcp.servers["docs.server"]).toMatchObject({ type: "local", command: ["node"] });
    expect(document.permissions).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "docs_server_*", resource: "*", effect: "deny" },
      { action: "docs_server_read", resource: "*", effect: "ask" },
      { action: "docs_server_write_file", resource: "*", effect: "allow" }
    ]);
  });

  it("maps an empty allowlist to deny all server tools", () => {
    const { homeDir, service } = setup();
    const codexPath = path.join(homeDir, ".codex", "config.toml");
    mkdirSync(path.dirname(codexPath), { recursive: true });
    writeFileSync(codexPath, '[mcp_servers.local]\ncommand = "node"\nenabled_tools = []\n');
    const source = service.list({ provider: "codex", scope: "user" });
    const destination = service.list({ provider: "opencode", scope: "user" });
    expect(service.copy({ source: { provider: "codex", scope: "user" }, name: "local",
      expectedSourceVersion: source.version, expectedDestinationVersion: destination.version }).permissionsCopied).toBe(true);
    const document = JSON.parse(readFileSync(path.join(homeDir, ".config", "opencode", "opencode.json"), "utf8"));
    expect(document.permissions).toEqual([{ action: "local_*", resource: "*", effect: "deny" }]);
  });

  it("rejects tool rules that could also match an existing OpenCode server", () => {
    const { homeDir, service } = setup();
    const codexPath = path.join(homeDir, ".codex", "config.toml");
    const openCodePath = path.join(homeDir, ".config", "opencode", "opencode.json");
    mkdirSync(path.dirname(codexPath), { recursive: true });
    mkdirSync(path.dirname(openCodePath), { recursive: true });
    writeFileSync(codexPath, '[mcp_servers.docs]\ncommand = "node"\nenabled_tools = ["read"]\n');
    writeFileSync(openCodePath, '{"mcp":{"servers":{"docs_more":{"type":"local","command":["node"]}}}}');
    const source = service.list({ provider: "codex", scope: "user" });
    const destination = service.list({ provider: "opencode", scope: "user" });
    expect(() => service.copy({ source: { provider: "codex", scope: "user" }, name: "docs",
      expectedSourceVersion: source.version, expectedDestinationVersion: destination.version })).toThrow(/工具名称可能重叠/);
    expect(JSON.parse(readFileSync(openCodePath, "utf8")).mcp.servers).toHaveProperty("docs_more");
  });

  it.each([
    ['default_tools_approval_mode = "writes"', /default_tools_approval_mode.*writes/],
    ['default_tools_approval_mode = "auto"', /default_tools_approval_mode.*auto/],
    ['enabled_tools = ["read", "read"]', /enabled_tools.*重复/],
    ['[mcp_servers.local.tools.read]\noutput_token_limit = 100', /tools.read/],
    ['[mcp_servers.local.tools.read]\napproval_mode = "writes"', /tools.read.approval_mode.*writes/]
  ])("rejects unsupported Codex tool policy without writing: %s", (setting, expectedError) => {
    const { homeDir, service } = setup();
    const codexPath = path.join(homeDir, ".codex", "config.toml");
    const openCodePath = path.join(homeDir, ".config", "opencode", "opencode.json");
    mkdirSync(path.dirname(codexPath), { recursive: true });
    mkdirSync(path.dirname(openCodePath), { recursive: true });
    writeFileSync(codexPath, `[mcp_servers.local]\ncommand = "node"\n${setting}\n`);
    writeFileSync(openCodePath, '{ "model": "keep" }\n');
    const source = service.list({ provider: "codex", scope: "user" });
    const destination = service.list({ provider: "opencode", scope: "user" });
    expect(() => service.copy({ source: { provider: "codex", scope: "user" }, name: "local",
      expectedSourceVersion: source.version, expectedDestinationVersion: destination.version })).toThrow(expectedError);
    expect(readFileSync(openCodePath, "utf8")).toBe('{ "model": "keep" }\n');
    expect(existsSync(`${openCodePath}.pannel-handle.bak`)).toBe(false);
  });

  it("copies OpenCode HTTP and local servers back to Codex with environment references", () => {
    const { homeDir, service } = setup();
    const openCodePath = path.join(homeDir, ".config", "opencode", "opencode.json");
    mkdirSync(path.dirname(openCodePath), { recursive: true });
    writeFileSync(openCodePath, JSON.stringify({ mcp: { servers: {
      remote: { type: "remote", url: "https://example.test/mcp", disabled: true, oauth: false,
        headers: { Authorization: "Bearer {env:MCP_TOKEN}", "X-Tenant": "{env:TENANT}" },
        timeout: { startup: 1500, execution: 4500 } },
      local: { type: "local", command: ["node", "tool.js"], environment: { TOKEN: "{env:TOKEN}" } }
    } } }, null, 2));
    for (const name of ["remote", "local"]) {
      const source = service.list({ provider: "opencode", scope: "user" });
      const destination = service.list({ provider: "codex", scope: "user" });
      expect(service.copy({ source: { provider: "opencode", scope: "user" }, name,
        expectedSourceVersion: source.version, expectedDestinationVersion: destination.version }).status).toBe("copied");
    }
    const codex = service.list({ provider: "codex", scope: "user" });
    expect(codex.servers.find(server => server.name === "remote")).toMatchObject({ enabled: false, bearerTokenEnvVar: "MCP_TOKEN", startupTimeoutSec: 1.5, toolTimeoutSec: 4.5 });
    const toml = readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('X-Tenant = "TENANT"');
    expect(toml).toMatch(/env_vars = \[\s*"TOKEN"\s*]/);
  });

  it("blocks incompatible settings, duplicate names, and stale versions without writing", () => {
    const { homeDir, service } = setup();
    const openCodePath = path.join(homeDir, ".config", "opencode", "opencode.json");
    mkdirSync(path.dirname(openCodePath), { recursive: true });
    writeFileSync(openCodePath, JSON.stringify({ mcp: { servers: {
      custom: { type: "remote", url: "https://example.test/mcp", codemode: false },
      duplicate: { type: "local", command: ["node"] }
    } } }));
    const codexPath = path.join(homeDir, ".codex", "config.toml");
    mkdirSync(path.dirname(codexPath), { recursive: true });
    writeFileSync(codexPath, '[mcp_servers.duplicate]\ncommand = "node"\n');
    const source = service.list({ provider: "opencode", scope: "user" });
    const destination = service.list({ provider: "codex", scope: "user" });
    const copy = name => service.copy({ source: { provider: "opencode", scope: "user" }, name,
      expectedSourceVersion: source.version, expectedDestinationVersion: destination.version });
    expect(() => copy("custom")).toThrow(/codemode/);
    expect(copy("duplicate")).toEqual({ status: "exists" });
    expect(service.copy({ source: { provider: "opencode", scope: "user" }, name: "custom",
      expectedSourceVersion: "stale", expectedDestinationVersion: destination.version })).toEqual({ status: "conflict" });
    expect(readFileSync(codexPath, "utf8")).toBe('[mcp_servers.duplicate]\ncommand = "node"\n');
    expect(existsSync(`${codexPath}.pannel-handle.bak`)).toBe(false);
  });

  it("copies project MCP only within the selected Windows project and masks OpenCode secrets", () => {
    const { projectDirectory, service } = setup();
    const codexPath = path.join(projectDirectory, ".codex", "config.toml");
    mkdirSync(path.dirname(codexPath), { recursive: true });
    writeFileSync(codexPath, '[mcp_servers.project-api]\nurl = "https://example.test/mcp?token=private"\n');
    const source = service.list({ provider: "codex", scope: "project", sessionId: "windows" });
    const destination = service.list({ provider: "opencode", scope: "project", sessionId: "windows" });
    expect(service.copy({ source: { provider: "codex", scope: "project", sessionId: "windows" },
      name: "project-api", expectedSourceVersion: source.version, expectedDestinationVersion: destination.version }).status).toBe("copied");
    const openCode = service.list({ provider: "opencode", scope: "project", sessionId: "windows" });
    expect(openCode.path).toBe(path.join(projectDirectory, "opencode.json"));
    expect(openCode.servers[0]).toMatchObject({ name: "project-api", url: "", urlMasked: true });
    expect(service.reveal({ provider: "opencode", scope: "project", sessionId: "windows", name: "project-api",
      field: "url", expectedVersion: openCode.version })).toEqual({ status: "revealed", value: "https://example.test/mcp?token=private" });
  });
});
