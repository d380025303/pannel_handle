import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { prepareCodexInheritance, readMcpDocuments, codeBuddyInheritanceArgs } = require("./codex-inheritance.cjs");
const { buildInvocation } = require("./session-service.cjs");
const { buildAgentStartCommand } = require("../../hooks/agent-session-launcher.cjs");
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("stages user and project Codex skills and MCP for a Windows CodeBuddy session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-inherit-test-")); roots.push(root);
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(home, ".codex", "skills", "review"), { recursive: true });
  fs.mkdirSync(path.join(project, ".agents", "skills", "review"), { recursive: true });
  fs.mkdirSync(path.join(project, ".agents", "skills", "project"), { recursive: true });
  fs.mkdirSync(path.join(project, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "skills", "review", "SKILL.md"), "user review");
  fs.writeFileSync(path.join(project, ".agents", "skills", "review", "SKILL.md"), "project review");
  fs.writeFileSync(path.join(project, ".agents", "skills", "project", "SKILL.md"), "project skill");
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), '[mcp_servers.sample]\ncommand = "node"\nargs = ["user"]\n');
  fs.writeFileSync(path.join(project, ".codex", "config.toml"), '[mcp_servers.sample]\ncommand = "node"\nargs = ["project"]\n');
  const result = await prepareCodexInheritance({ id: "session", type: "windows", cwd: project }, { homeDir: home });
  try {
    expect(result.pluginDir).toBeTruthy();
    expect(fs.readFileSync(path.join(result.pluginDir, "skills", "review", "SKILL.md"), "utf8")).toBe("project review");
    expect(fs.readFileSync(path.join(result.pluginDir, "skills", "project", "SKILL.md"), "utf8")).toBe("project skill");
    expect(JSON.parse(fs.readFileSync(result.mcpFile, "utf8")).mcpServers.sample.args).toEqual(["project"]);
    expect(codeBuddyInheritanceArgs(result, "powershell")).toContain("--plugin-dir");
  } finally { await result.cleanup(); }
  expect(fs.existsSync(result.pluginDir)).toBe(false);
  expect(fs.existsSync(result.mcpFile)).toBe(false);
});

it("converts bearer authentication and rejects unsupported Codex MCP fields", () => {
  const converted = readMcpDocuments([["user", '[mcp_servers.api]\nurl = "https://example.test/mcp"\nbearer_token_env_var = "API_TOKEN"\n']]);
  expect(converted.api.headers.Authorization).toBe("Bearer ${API_TOKEN}");
  expect(() => readMcpDocuments([["user", '[mcp_servers.bad]\ncommand = "node"\ncwd = "/tmp"\n']]))
    .toThrow("不支持的 cwd");
  const warnings = [];
  expect(readMcpDocuments([["user", '[mcp_servers.slow]\ncommand = "node"\nstartup_timeout_sec = 30\n']], warnings).slow.command)
    .toBe("node");
  expect(warnings).toHaveLength(1);
});

it("adds the same staged configuration to graphical and terminal CodeBuddy launches", () => {
  const inheritance = { pluginDir: "C:\\tmp\\codex skills", mcpFile: "C:\\work\\codex mcp.json" };
  const session = { id: "one", type: "windows", cwd: "C:\\work", shell: "powershell.exe", agentProvider: "codebuddy" };
  const terminal = buildAgentStartCommand(session, { inheritance });
  const graphical = buildInvocation(session, { inheritance }, {}, "codebuddy").args.join(" ");
  expect(terminal).toContain("--plugin-dir 'C:\\tmp\\codex skills'");
  expect(terminal).toContain("--mcp-config 'C:\\work\\codex mcp.json'");
  expect(graphical).toContain("--plugin-dir 'C:\\tmp\\codex skills'");
  expect(graphical).toContain("--mcp-config 'C:\\work\\codex mcp.json'");
});
