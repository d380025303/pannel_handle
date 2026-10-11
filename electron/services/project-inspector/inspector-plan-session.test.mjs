import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { createCodexAppServerSessionService } = require("../codex-app-server/session-service.cjs");
const { DISABLED_FEATURES } = require("./reviewer-agent-runner.cjs");
const { assertInspectorConfiguration, inspectorInvocationArgs } = require("./inspector-session-policy.cjs");
function config() { return { sandbox_mode: "read-only", approval_policy: "never", web_search: "disabled", features: { ...Object.fromEntries(DISABLED_FEATURES.map(name => [name, false])), skip_host_skill_discovery: true } }; }
function fixture(mcpStatus = { data: [], nextCursor: null }, implementation = false) {
  const received = [];
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit("exit", 0);
  let buffer = "";
  child.stdin.on("data", chunk => {
    buffer += chunk.toString(); const lines = buffer.split("\n"); buffer = lines.pop();
    for (const line of lines) {
      const request = JSON.parse(line); received.push(request);
      if (request.id == null) continue;
      const result = request.method === "config/read" ? { config: implementation ? { ...config(), sandbox_mode: "workspace-write", features: { ...config().features, shell_tool: true, unified_exec: true, code_mode: true, code_mode_host: true }, sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true } } : config(), origins: {} }
        : request.method === "configRequirements/read" ? { requirements: null }
          : request.method === "mcpServerStatus/list" ? mcpStatus
            : request.method === "thread/start" ? { thread: { id: "thread", model: "test-model" } }
              : request.method === "model/list" ? { data: [{ id: "test-model", isDefault: true }] }
                : request.method === "turn/start" ? { turn: { id: "turn", status: "inProgress" } } : {};
      child.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
    }
  });
  const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) }, terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child,
    resolveInspectorExecutable: async () => "codex.exe", resolveInspectorMcpConfig: async () => ["external"] });
  const session = { id: "plan", type: "windows", agentProvider: "codex", shell: "cmd.exe", cwd: "C:/project", inspectorStage: "planning", graphicalSessionEnabled: true };
  if (implementation) Object.assign(session, { inspectorStage: "implementation", inspectorWorkspaceId: "workspace", cwd: "C:/data/inspector-worktrees/workspace" });
  return { service, session, child, received };
}
it("enforces Plan and readOnly in the main process and blocks independent execution paths", async () => {
  const f = fixture();
  try {
    expect(await f.service.start(f.session)).toMatchObject({ inspectorSafety: "enforced", mode: "plan", executionPermission: "readOnly" });
    expect(() => f.service.setMode("plan", "default")).toThrow("不授权实施");
    await expect(f.service.setExecutionPermission("plan", "fullAccess")).rejects.toThrow("只读");
    await expect(f.service.executePlan("plan", "item")).rejects.toThrow("独立的实施审批");
    expect(() => f.service.reloadMcpServers("plan")).toThrow("外部工具");
    await expect(f.service.setSkillEnabled("plan", "skill", true)).rejects.toThrow("技能配置");
    await f.service.submit("plan", "review evidence");
    const turn = f.received.find(request => request.method === "turn/start");
    expect(turn.params.sandboxPolicy.type).toBe("readOnly"); expect(turn.params.approvalPolicy).toBe("never");
    expect(f.received.find(request => request.method === "thread/start").params.sandbox).toBe("read-only");
  } finally { f.service.close("plan"); }
});
it("refuses submission when an MCP server is connected even if it has no listed tools", async () => {
  const f = fixture({ data: [{ name: "unexpected", runtimeStatus: "connected", tools: {}, resources: [], resourceTemplates: [] }], nextCursor: null });
  try { await expect(f.service.start(f.session)).rejects.toThrow("工具隔离"); expect(f.received.some(request => request.method === "turn/start")).toBe(false); }
  finally { f.service.close("plan"); }
});
it("accepts disabled empty MCP descriptors but never trusts absent runtime evidence", () => {
  expect(() => assertInspectorConfiguration(config(), { data: [{ runtimeStatus: "disabled", tools: {}, resources: [], resourceTemplates: [] }] })).not.toThrow();
  expect(() => assertInspectorConfiguration(config(), { data: [{ tools: {} }] })).toThrow("工具隔离");
  expect(inspectorInvocationArgs(["external"])).toContain("mcp_servers.external.enabled=false");
});

it("pins implementation to a workspace sandbox with no escalation or external tool paths", async () => {
  const f = fixture(undefined, true);
  try {
    expect(await f.service.start(f.session)).toMatchObject({ inspectorSafety: "enforced", inspectorStage: "implementation", mode: "default", executionPermission: "askApproval" });
    await expect(f.service.setExecutionPermission("plan", "fullAccess")).rejects.toThrow("写入边界");
    expect(() => f.service.setMode("plan", "plan")).toThrow();
    expect(() => f.service.reloadMcpServers("plan")).toThrow("外部工具");
    await f.service.submit("plan", "implement the approved Plan");
    const turn = f.received.find(request => request.method === "turn/start");
    expect(turn.params.sandboxPolicy).toEqual({ type: "workspaceWrite", writableRoots: [f.session.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
    expect(turn.params.approvalPolicy).toBe("never");
    expect(f.received.find(request => request.method === "thread/start").params.sandbox).toBe("workspace-write");
  } finally { f.service.close("plan"); }
});
it("rejects additional implementation writable roots even when other controls pass", () => {
  const c = { ...config(), sandbox_mode: "workspace-write", features: { ...config().features, shell_tool: true, unified_exec: true, code_mode: true, code_mode_host: true }, sandbox_workspace_write: { writable_roots: ["C:/source"], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true } };
  expect(() => assertInspectorConfiguration(c, { data: [] }, { inspectorStage: "implementation" })).toThrow("工具隔离");
});
