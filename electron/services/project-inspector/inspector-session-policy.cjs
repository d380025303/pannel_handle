const IMPLEMENTATION_FEATURES = ["shell_tool", "unified_exec", "code_mode", "code_mode_host"];
const { DISABLED_FEATURES } = require("./reviewer-agent-runner.cjs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { parse } = require("smol-toml");

function isInspectorImplementation(session) { return session?.inspectorStage === "implementation"; }
function isInspectorProtected(session) { return isInspectorPlanning(session) || isInspectorImplementation(session); }
function isInspectorPlanning(session) { return session?.inspectorStage === "planning"; }
function assertInspectorPlanning(session) {
  if (!isInspectorProtected(session)) return;
  if (isInspectorImplementation(session) && (!session.inspectorWorkspaceId || path.basename(session.cwd) !== session.inspectorWorkspaceId || path.basename(path.dirname(session.cwd)) !== "inspector-worktrees")) throw new Error("实施会话必须使用关联的隔离工作树。");
  if (session.type !== "windows" || session.agentProvider !== "codex" || session.graphicalSessionEnabled === false || session.initialCommand) throw new Error("巡检规划只允许独立的本地 Codex 图形会话。");
}
async function resolveInspectorMcpServers(cwd, environment = process.env) {
  const home = environment.CODEX_HOME || path.join(os.homedir(), ".codex");
  if (!path.isAbsolute(home)) throw new Error("Codex 配置目录必须是绝对路径。");
  const files = new Set([path.join(home, "config.toml")]);
  if (environment.ProgramData) files.add(path.join(environment.ProgramData, "OpenAI", "Codex", "config.toml"));
  for (let current = path.resolve(cwd);; current = path.dirname(current)) {
    files.add(path.join(current, ".codex", "config.toml"));
    if (path.dirname(current) === current) break;
  }
  const names = new Set();
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (value.mcp_servers && typeof value.mcp_servers === "object") for (const name of Object.keys(value.mcp_servers)) names.add(name);
    for (const nested of Object.values(value)) if (nested && typeof nested === "object") visit(nested);
  };
  for (const file of files) {
    let text;
    try { if ((await fs.stat(file)).size > 2 * 1024 * 1024) throw new Error("Codex 配置超过安全读取上限。"); text = await fs.readFile(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const config = parse(text); visit(config);
    if (file === path.join(home, "config.toml") && config.profile) {
      if (typeof config.profile !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(config.profile)) throw new Error("Codex 配置 profile 无法安全解析。");
      files.add(path.join(home, `${config.profile}.config.toml`));
    }
  }
  if ([...names].some(name => !/^[a-zA-Z0-9_-]{1,100}$/.test(name))) throw new Error("Codex MCP 名称无法安全禁用，请检查配置。");
  return [...names];
}
function inspectorInvocationArgs(mcpServers = [], session) {
  const implementation = isInspectorImplementation(session);
  const disabled = implementation ? DISABLED_FEATURES.filter(name => !IMPLEMENTATION_FEATURES.includes(name)) : DISABLED_FEATURES;
  return ["-c", `sandbox_mode="${implementation ? "workspace-write" : "read-only"}"`, "-c", "approval_policy=\"never\"", "-c", "mcp_servers={}", "-c", "notify=[]", "-c", "web_search=\"disabled\"",
    "-c", "features.skip_host_skill_discovery=true", "-c", "suppress_unstable_features_warning=true", "-c", "features.shell_snapshot=false",
    ...(implementation ? ["-c", "sandbox_workspace_write.writable_roots=[]", "-c", "sandbox_workspace_write.network_access=false", "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true", "-c", "sandbox_workspace_write.exclude_slash_tmp=true", ...IMPLEMENTATION_FEATURES.flatMap(name => ["--enable", name])] : []), ...disabled.flatMap(name => ["--disable", name]), ...mcpServers.flatMap(name => ["-c", `mcp_servers.${name}.enabled=false`]), "app-server", "--stdio"];
}
function assertInspectorConfiguration(config, mcpStatus, session) {
  const implementation = isInspectorImplementation(session);
  const disabled = implementation ? DISABLED_FEATURES.filter(name => !IMPLEMENTATION_FEATURES.includes(name)) : DISABLED_FEATURES;
  const checks = {
    sandbox: config?.sandbox_mode === (implementation ? "workspace-write" : "read-only"), approval: config?.approval_policy === "never", webSearch: config?.web_search === "disabled",
    mcp: Array.isArray(mcpStatus?.data) && !mcpStatus.nextCursor && mcpStatus.data.every(server => server.runtimeStatus === "disabled"
      && server.tools && Object.keys(server.tools).length === 0 && Array.isArray(server.resources) && server.resources.length === 0
      && Array.isArray(server.resourceTemplates) && server.resourceTemplates.length === 0),
    notify: !config?.notify || (Array.isArray(config.notify) && config.notify.length === 0),
    workspace: !implementation || (config?.sandbox_workspace_write?.network_access === false && config.sandbox_workspace_write.exclude_tmpdir_env_var === true && config.sandbox_workspace_write.exclude_slash_tmp === true && Array.isArray(config.sandbox_workspace_write.writable_roots) && config.sandbox_workspace_write.writable_roots.length === 0),
    features: disabled.every(name => config?.features?.[name] === false) && (!implementation || IMPLEMENTATION_FEATURES.every(name => config?.features?.[name] === true)), skills: config?.features?.skip_host_skill_discovery === true
  };
  const failed = Object.keys(checks).filter(key => !checks[key]);
  if (failed.length) throw new Error(`无法确认规划会话的工具隔离（${failed.join(", ")}），已禁止提交任务。`);
}
module.exports = { isInspectorPlanning, isInspectorImplementation, isInspectorProtected, assertInspectorPlanning, resolveInspectorMcpServers, inspectorInvocationArgs, assertInspectorConfiguration };
