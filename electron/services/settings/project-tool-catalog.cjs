const { z } = require("zod");
const { SESSION_TOOLS } = require("../mcp/session-tool-definitions.cjs");
const { TOOLS } = require("../module-owners/module-owner-service.cjs");
const { REMOTE_TOOLS } = require("../../ssh/remote-agent-bridge-service.cjs");
const text = (zh, en) => ({ "zh-CN": zh, "en-US": en });
const fields = { name: "桌面界面", responsibilities: "维护桌面交互", directories: ["src"], recentActivity: "检查桌面交互并修复布局问题" };
const identity = { id: "<OWNER_ID>", version: 1 };
const timestamp = 1791763200000;
const owner = { ...identity, ...fields, createdAt: timestamp, updatedAt: timestamp };
const session = { sessionId: "<SESSION_ID>", title: "项目分析", templateId: "<TEMPLATE_ID>", runtimeMode: "app-server", type: "windows", agentProvider: "codex", sshConnectionState: null, workState: "running", summary: "正在分析项目结构", queriedAt: timestamp };
// Examples describe the tool payload: callback output JSON for owners, MCP text JSON for other tools.
const resultExamples = {
  list_module_owners: [owner],
  add_module_owner: { operation: "add", revision: 1, id: owner.id, record: owner },
  update_module_owner: { operation: "update", revision: 2, id: owner.id, record: { ...owner, version: 2, updatedAt: timestamp + 1000 } },
  delete_module_owner: { operation: "delete", revision: 3, id: owner.id },
  list_session_instances: { sessions: [session] },
  get_session_instance_status: session,
  list_session_templates: { templates: [{ templateId: "<TEMPLATE_ID>", title: "项目分析", agentProvider: "codex", type: "windows", graphicalSessionEnabled: true, modelSource: "native", modelId: null }] },
  create_session_instance: { sessionId: "<SESSION_ID>", templateId: "<TEMPLATE_ID>", agentProvider: "codex", mode: "plan", modelSource: "native", modelId: null, status: "started" },
  remote_context: { sessionId: "<SSH_SESSION_ID>", type: "ssh", platform: "linux", host: "example.invalid", username: "developer", root: "/workspace/project" },
  remote_list: { path: "/workspace/project", entries: [{ name: "README.md", path: "/workspace/project/README.md", type: "file", size: 10, modifiedAt: timestamp }] },
  remote_search: { root: "/workspace/project", mode: "text", output: "./src/app.ts:12:TODO: add validation\n" },
  remote_read_text: { path: "/workspace/project/README.md", kind: "text", size: 10, content: "# Project\n", version: "<CONTENT_VERSION>", encoding: "utf-8", bom: false, eol: "lf" },
  remote_apply_patch: { changes: [{ path: "notes.txt", status: "saved", version: "<CONTENT_VERSION>", size: 8 }] },
  remote_exec: { cwd: "/workspace/project", exitCode: 0, signal: null, stdout: " M notes.txt\n", stderr: "", truncated: false }
};
const metadata = {
  list_module_owners: ["查询模块负责人", "List module owners", { name: fields.name }, true, "返回当前来源模板负责人、近期行为及最新版本；可选 name 去除首尾空白后精确匹配，不传则返回全部，未匹配返回空数组。", "Returns owners, recentActivity and their latest versions for the source template. Optional name matches exactly after trimming; omit it for all owners. No match returns an empty array."],
  add_module_owner: ["新增模块负责人", "Add a module owner", fields, false, "返回操作类型、表修订号、新记录 ID 和负责人记录，记录 AI 修改历史。", "Returns the operation, table revision, new record ID and owner record, and records AI change history."],
  update_module_owner: ["修改模块负责人", "Update a module owner", { ...identity, ...fields }, false, "须提交名称、职责和目录；recentActivity 可选，未传保留，空字符串清空；版本冲突后重新查询。定时任务仅允许修改绑定负责人。", "Submit name, responsibilities and directories; optional recentActivity preserves its value when omitted and clears it when empty; re-query on version conflicts. Scheduled tasks can only update their bound owner."],
  delete_module_owner: ["删除模块负责人", "Delete a module owner", identity, false, "删除并记录历史；版本冲突后重新查询。", "Deletes the owner and records history; re-query on version conflicts."],
  list_session_instances: ["查询运行会话", "List running sessions", {}, true, "返回运行实例、Agent 状态和最近活动摘要，不查询历史对话。", "Returns running instances, Agent status and recent activity without historical conversations."],
  get_session_instance_status: ["查询单个会话状态", "Get session status", { sessionId: "<SESSION_ID>" }, true, "返回实例状态和最近摘要；不存在或已结束则报错。", "Returns instance status and recent activity; missing or ended instances return an error."],
  list_session_templates: ["查询 Agent 模板", "List Agent templates", {}, true, "返回配置了 Agent 的模板及模型信息，排除凭据和启动命令。", "Returns Agent templates and model information, excluding credentials and startup commands."],
  create_session_instance: ["创建图形 Agent 会话", "Create an Agent session", { templateId: "<TEMPLATE_ID>", mode: "plan", prompt: "分析项目结构" }, false, "started 表示首条任务已提交，不表示完成。每次调用新建实例；超时后先查状态再决定重试。", "started means the first prompt was submitted, not completed. Each call creates an instance; check status before retrying a timeout."],
  remote_context: ["查看远程工作区", "Inspect remote workspace", {}, true, "返回 SSH 目标、远程平台和权威工作目录。", "Returns the SSH target, remote platform and authoritative workspace root."],
  remote_list: ["列出远程目录", "List a remote directory", { path: "." }, true, "返回远程工作区内的目录内容。", "Returns directory entries within the remote workspace."],
  remote_search: ["搜索远程文件与文本", "Search remote files and text", { query: "TODO", path: ".", mode: "text", limit: 100 }, true, "返回搜索匹配结果；不要求服务器安装 ripgrep。", "Returns search matches without requiring ripgrep on the server."],
  remote_read_text: ["读取远程文本", "Read remote text", { path: "README.md" }, true, "返回 UTF-8 内容及版本；修改或删除时使用该版本。", "Returns UTF-8 content and a version to use for updates or deletion."],
  remote_apply_patch: ["修改远程文本文件", "Change remote text files", { changes: [{ path: "notes.txt", content: "New file" }] }, false, "新增、完整替换或删除文件；更新与删除须携带读取所得 expectedVersion，content 为 null 表示删除。", "Creates, replaces or deletes files. Updates and deletion require expectedVersion from a read; null content deletes a file."],
  remote_exec: ["执行远程命令", "Run a remote command", { command: "git status --short", cwd: ".", timeoutMs: 120000 }, false, "返回退出码、stdout、stderr 和截断状态；命令通过独立 SSH 通道执行。", "Returns exit code, stdout, stderr and truncation status; commands run through a separate SSH channel."]
};
const conditions = {
  owners: text("通过模块负责人生成流程注入，仅支持有项目目录的本机 Windows Codex 图形模板，并须开启 HTTP 接口。临时授权绑定来源模板和活动工具请求；定时任务可选负责人查询和修改工具。目录必须位于项目内。", "Injected by module-owner generation for local Windows Codex graphical templates with a project directory and HTTP service enabled. Temporary grants bind the source template and active tool call. Scheduled tasks can select owner listing and update tools. Directories must remain inside the project."),
  sessions: text("通过本机会话 MCP 调用，须启用服务并使用 Bearer 授权。创建实例只接受图形 Agent 模板，沿用现有权限流程；自定义工具与回调必须成对提供，注入仅支持本机 Windows Codex。", "Available through the local session MCP with the service enabled and Bearer authorization. Creation requires a graphical Agent template and follows existing permissions. Custom tools and callback must be paired; injection supports local Windows Codex only."),
  remote: text("通过本地 Agent 的 SSH 远程桥接 MCP 调用，需要已建立绑定的 SSH 会话。文件路径和命令工作目录受远程工作区限制；写入和执行遵循桥接审批策略。", "Available through the local Agent SSH bridge MCP with a bound SSH session. File paths and command directories are restricted to the remote workspace; writes and commands follow bridge approval policy.")
};
function listProjectTools() {
  const sessions = Object.entries(SESSION_TOOLS).map(([name, definition]) => ({ name, description: definition.description, inputSchema: z.toJSONSchema(definition.inputSchema) }));
  return structuredClone([["owners", TOOLS], ["sessions", sessions], ["remote", REMOTE_TOOLS]].flatMap(([group, tools]) => tools.map(tool => {
    const [zh, en, example, readOnly, resultZh, resultEn] = metadata[tool.name];
    return { name: tool.name, group, description: tool.description, summary: text(zh, en), inputSchema: tool.inputSchema, example, readOnly, conditions: conditions[group], result: text(resultZh, resultEn), resultExample: resultExamples[tool.name] };
  })));
}
module.exports = { listProjectTools };
