import type { ProjectTool } from "../vite-env";

// Representative in-memory fixtures, not the live Electron tool catalog.
export const previewProjectTools: ProjectTool[] = [
  {
    name: "list_module_owners",
    group: "owners",
    description: "List module owners for the source template, optionally matching a name.",
    summary: { "zh-CN": "查询模块负责人", "en-US": "List module owners" },
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Optional exact owner name." } }
    },
    example: { name: "桌面界面" },
    conditions: {
      "zh-CN": "浏览器预览示例。实际工具由本机 Windows Codex 模块负责人流程注入，需要 HTTP 接口与临时授权。",
      "en-US": "Browser preview fixture. The real tool requires local Windows Codex module-owner injection, HTTP service and a temporary grant."
    },
    result: { "zh-CN": "返回来源模板的负责人和最新版本，未匹配时返回空数组。", "en-US": "Returns source-template owners and latest versions, or an empty array when unmatched." },
    resultExample: [{ id: "preview-owner", version: 1, name: "桌面界面", responsibilities: "维护桌面交互与窄窗口布局", directories: ["src/components", "src/browser-preview"], recentActivity: "检查项目工具目录与详情弹窗", createdAt: 1791763200000, updatedAt: 1791763200000 }]
  },
  {
    name: "get_session_instance_status",
    group: "sessions",
    description: "Get the status and recent activity of a running session instance.",
    summary: { "zh-CN": "查询单个会话状态", "en-US": "Get session status" },
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string", description: "Running session instance ID." } },
      required: ["sessionId"]
    },
    example: { sessionId: "preview-session" },
    conditions: {
      "zh-CN": "浏览器预览示例。实际调用使用本机会话 MCP，需要启用服务和 Bearer 授权。",
      "en-US": "Browser preview fixture. Real calls use the local session MCP with the service enabled and Bearer authorization."
    },
    result: { "zh-CN": "返回实例状态和最近摘要；实例不存在或已结束则报错。", "en-US": "Returns status and recent activity; missing or ended instances return an error." },
    resultExample: { sessionId: "preview-session", title: "项目工具界面验收", templateId: "preview-local-template", runtimeMode: "app-server", type: "windows", agentProvider: "codex", sshConnectionState: null, workState: "running", summary: "正在检查目录搜索、详情内容、JSON 示例与深浅主题布局。", queriedAt: 1791763200000 }
  },
  {
    name: "remote_apply_patch",
    group: "remote",
    description: "Create, replace or delete text files inside the remote workspace.",
    summary: { "zh-CN": "修改远程文本文件", "en-US": "Change remote text files" },
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          description: "Changes within the remote workspace.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Workspace-relative file path." },
              content: { type: ["string", "null"], description: "Replacement UTF-8 content; null deletes the file." },
              expectedVersion: { type: "string", description: "Version from remote_read_text, required for updates and deletion." }
            },
            required: ["path", "content"]
          }
        }
      },
      required: ["changes"]
    },
    example: { changes: [{ path: "docs/browser-preview/project-tools-layout-check.md", content: "# 项目工具预览\n检查长工具名、JSON 示例与详情滚动。\n" }] },
    conditions: {
      "zh-CN": "浏览器预览示例，不会写入文件。实际调用需要绑定的 SSH 会话，路径受远程工作区限制，写入遵循桥接审批策略。",
      "en-US": "Browser preview fixture; no files are written. Real calls require a bound SSH session, workspace-scoped paths and bridge write approval."
    },
    result: { "zh-CN": "返回变更路径、保存状态和内容版本。更新与删除须携带读取所得版本。", "en-US": "Returns changed paths, save status and content versions. Updates and deletion require the version returned by a read." },
    resultExample: { changes: [{ path: "docs/browser-preview/project-tools-layout-check.md", status: "saved", version: "preview-content-version", size: 90 }] }
  }
];
