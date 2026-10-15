import { installPreviewTransport, type RemoteSocket } from "../remoteSocket";
import type { ClientMessage, GraphicalSnapshot, RuntimeSession, SavedTemplate, ServerMessage } from "../types";
import type { CodexConfigurationView, CodexSessionCapabilities, WorkItem, WorkItemAttempt, WorkItemQuickPrompt } from "../../../src/vite-env";

const longText = "浏览器内存预览：检查窄屏长文本换行、弹窗滚动与模拟交互。".repeat(24);
const cwd = "C:\\preview";
const configurationCwd = `${cwd}\\移动端配置与权限验收\\包含长路径的工作区\\projects\\terminal-session-manager\\mobile-browser-preview`;
const permissionProfiles = [
  { id: "workspace", allowed: true, reason: null, description: "仅允许修改当前工作区；访问工作区外文件或执行网络请求时需要确认。" },
  { id: "audit", allowed: true, reason: null, description: "只读审查权限档：用于检查项目配置与代码，不允许修改文件。" },
  { id: "unrestricted", allowed: false, reason: "管理员限制：不允许绕过审批或访问工作区外的敏感目录。请使用工作区权限档，并在需要额外访问时逐次确认。", description: "无限制访问（预览中禁用）" }
];
const legacyPermissions: CodexConfigurationView["legacy"] = [
  { id: "readOnly", allowed: true, reason: null }, { id: "askApproval", allowed: true, reason: null },
  { id: "fullAccess", allowed: false, reason: "管理员限制：当前工作区禁止完全访问，写入与网络访问须遵循审批策略。" }
];

export class PreviewSocket extends EventTarget {
  readyState = 0;
  private sessions: RuntimeSession[] = [
    { id: "preview-terminal", templateId: "preview-template", title: "终端 · 长标题窄屏布局验收与模拟输入", type: "windows", runtimeMode: "terminal", cwd,
      quickCommands: [{ id: "status", command: "git status", pinned: true }] },
    { id: "preview-graphical", templateId: "preview-agent", title: "图形会话 · 界面验收", type: "windows", runtimeMode: "app-server", agentProvider: "codex", cwd }
  ];
  private templates: SavedTemplate[] = [
    { id: "preview-template", title: "本地终端模板 · 长标题展示", type: "windows", runtimeMode: "terminal", cwd, runningCount: 1 },
    { id: "preview-agent", title: "图形助手模板", type: "windows", runtimeMode: "app-server", agentProvider: "codex", cwd, runningCount: 1 }
  ];
  private snapshot: GraphicalSnapshot = { threadId: "preview-thread", provider: "codex", busy: false, archived: false,
    error: null, mode: "default", executionPermission: "askApproval", permissionProfileId: null,
    permissionOptions: legacyPermissions, nativeMode: null, capabilities: { history: true, plan: true, permissions: true }, pendingPlan: null,
    model: "preview-model", models: [{ id: "preview-model", displayName: "预览模型" }], effort: "medium",
    items: [{ id: "user", type: "userMessage", text: "请检查移动端布局。" },
      { id: "assistant", type: "agentMessage", text: `## 移动端预览\n\n${longText}\n\n- 会话与模板\n- 任务与文件\n- 图形消息交互` }], approvals: [], questions: [] };
  private tasks: WorkItem[] = [];
  private attempts: WorkItemAttempt[] = [];
  private prompts: WorkItemQuickPrompt[] = [{ id: "prompt", version: 1, name: "验收提示", prompt: "检查窄屏界面并记录结果。", persistent: true }];
  private seq = 1;
  private downloadUrls: string[] = [];

  constructor() {
    super();
    const now = Date.now();
    this.tasks = [{ id: "preview-task", sourceRunId: "preview-run", taskId: "preview-task", ownerId: "preview-owner", templateId: "preview-agent",
      taskName: "检查移动端业务界面 · 长文本与弹窗滚动", output: longText,
      owner: { id: "preview-owner", version: 1, name: "预览负责人", responsibilities: "验收移动端界面", directories: [cwd], createdAt: now, updatedAt: now },
      template: { title: "图形助手模板", cwd }, tools: [], needsFollowUp: true, status: "pending", version: 1, createdAt: now, updatedAt: now, unavailable: "" }];
    queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event("open")); } });
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.downloadUrls.forEach(url => URL.revokeObjectURL(url));
    this.downloadUrls = [];
    this.dispatchEvent(new Event("close"));
  }

  private emit(message: ServerMessage) {
    queueMicrotask(() => { if (this.readyState === 1) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); });
  }

  send(raw: string) {
    if (this.readyState !== 1) return;
    const message = JSON.parse(raw) as ClientMessage;
    const ok = () => { if ("requestId" in message) this.emit({ v: 8, type: "command.ok", requestId: message.requestId }); };
    const snapshot = (sessionId: string) => this.emit({ v: 8, type: "graphical.snapshot", sessionId, snapshot: this.snapshot });
    const changed = () => {
      this.templates = this.templates.map(template => ({ ...template, runningCount: this.sessions.filter(session => session.templateId === template.id).length }));
      this.emit({ v: 8, type: "sessions.changed", sessions: this.sessions });
      this.emit({ v: 8, type: "templates.changed", templates: this.templates });
    };
    switch (message.type) {
      case "password.login":
        this.emit({ v: 8, type: "ready", payload: { deviceId: "preview-device", deviceName: "浏览器内存预览", sessions: this.sessions, templates: this.templates } });
        this.sessions.forEach(session => this.emit({ v: 8, type: "session.overview", overview: { sessionId: session.id, status: "空闲", summary: "模拟数据，可直接检查界面" } }));
        return;
      case "ping": this.emit({ v: 8, type: "pong", at: message.at }); return;
      case "terminal.subscribe": this.emit({ v: 8, type: "terminal.snapshot", snapshot: { sessionId: message.sessionId, ansi: "\u001b[32mBrowser Preview\u001b[0m\r\n无需电脑服务。输入内容将在此回显。\r\nPS C:\\preview> ", seq: this.seq, cols: 80, rows: 24, owner: "desktop" } }); return;
      case "terminal.input": this.emit({ v: 8, type: "terminal.data", sessionId: message.sessionId, data: message.data, seq: ++this.seq }); return;
      case "terminal.claim-size": case "terminal.resize": this.emit({ v: 8, type: "terminal.size-owner", sessionId: message.sessionId, owner: "preview-device", cols: message.cols, rows: message.rows }); return;
      case "session.duplicate": {
        const source = this.sessions.find(session => session.id === message.sessionId);
        if (!source) { this.emit({ v: 8, type: "error", code: "COMMAND_FAILED", message: "源会话已关闭，无法复制。", requestId: message.requestId }); return; }
        const template = this.templates.find(template => template.id === source.templateId);
        const session: RuntimeSession = { ...source, ...(template ?? {}), id: crypto.randomUUID() };
        this.sessions = [...this.sessions, session]; changed();
        this.emit({ v: 8, type: "command.ok", requestId: message.requestId, sessionId: session.id }); return;
      }
      case "session.rename": this.sessions = this.sessions.map(session => session.id === message.sessionId ? { ...session, title: message.title } : session); changed(); ok(); return;
      case "session.close": this.sessions = this.sessions.filter(session => session.id !== message.sessionId); changed(); ok(); return;
      case "template.launch": {
        const template = this.templates.find(template => template.id === message.templateId);
        if (!template) break;
        const session = { ...template, id: crypto.randomUUID(), templateId: template.id };
        this.sessions = [...this.sessions, session]; changed();
        this.emit({ v: 8, type: "session.launched", sessionId: session.id }); ok(); return;
      }
      case "sessions.close-completed": {
        const before = this.sessions.length;
        this.sessions = this.sessions.filter(session => !message.sessionIds.includes(session.id)); changed();
        this.emit({ v: 8, type: "sessions.close-completed.result", requestId: message.requestId, closed: before - this.sessions.length, skipped: 0, failed: 0 }); return;
      }
      case "files.list": {
        const path = message.path;
        this.emit({ v: 8, type: "files.list.result", requestId: message.requestId, path, entries: path === null
          ? [{ name: "预览磁盘 (C:)", path: "C:\\", type: "drive", size: null }]
          : [{ name: "界面验收资料与长文件夹名称", path: `${path}\\资料`, type: "directory", size: null },
            { name: "移动端窄屏布局与长文本验收说明.md", path: `${path}\\验收说明.md`, type: "file", size: longText.length * 3 }] }); return;
      }
      case "files.search.cancel": return;
      case "files.search": {
        const entries = [{ name: "验收说明.md", path: `${message.path.replace(/\\$/, "")}\\资料\\验收说明.md`, type: "file" as const, size: 120 }].filter(entry => entry.name.toLowerCase().includes(message.query.toLowerCase()));
        this.emit({ v: 8, type: "files.search.result", requestId: message.requestId, path: message.path, entries, reason: "complete", skipped: 0 }); return;
      }
      case "files.download.prepare":
        // Download a generated local artifact; never contact the real HTTP service.
        { const url = URL.createObjectURL(new Blob([longText], { type: "text/plain;charset=utf-8" }));
          this.downloadUrls.push(url);
          this.emit({ v: 8, type: "files.download.ready", requestId: message.requestId, url }); } return;
      case "work-items.request":
        try { this.emit({ v: 8, type: "work-items.result", requestId: message.requestId, result: this.workItem(message) }); }
        catch (error) { this.emit({ v: 8, type: "error", code: "PREVIEW_REQUEST", requestId: message.requestId, message: String(error) }); }
        return;
      case "graphical.subscribe": snapshot(message.sessionId); return;
      case "graphical.codex.configuration": {
        const values = { model: "preview-model", model_reasoning_effort: "medium", approval_policy: "on-request", sandbox_mode: "workspace-write", web_search: "cached" };
        const result: CodexConfigurationView = {
          cwd: configurationCwd,
          config: { status: "ready", data: { values, layers: [
            { type: "user", path: `${cwd}\\用户配置\\.codex\\config.toml`, disabled: false, values: { model: "preview-model", model_reasoning_effort: "medium" } },
            { type: "project", path: `${configurationCwd}\\.codex\\config.toml`, disabled: false, values: { approval_policy: "on-request", sandbox_mode: "workspace-write" } },
            { type: "project", path: `${configurationCwd}\\不受信任的子目录\\.codex\\config.toml`, disabled: true, values: { sandbox_mode: "danger-full-access" } }
          ] } },
          requirements: { status: "ready", data: { allowedApprovalPolicies: ["on-request"], allowedSandboxModes: ["read-only", "workspace-write"], allowedPermissionProfiles: ["workspace", "audit"], network: "只允许经审批的网络请求；禁止访问内部管理地址和敏感服务。此说明用于验收长内容换行与滚动。" } },
          profiles: { status: "ready", data: permissionProfiles }, legacy: legacyPermissions,
          runtime: { model: this.snapshot.model, effort: this.snapshot.effort, mode: this.snapshot.mode,
            executionPermission: this.snapshot.executionPermission === "readOnly" ? "readOnly" : "askApproval", permissionProfileId: this.snapshot.permissionProfileId ?? null }
        };
        this.emit({ v: 8, type: "graphical.result", sessionId: message.sessionId, threadId: this.snapshot.threadId, requestId: message.requestId, result }); return;
      }
      case "graphical.codex.permission-profile": case "graphical.codex.permission-legacy": {
        const profile = message.type === "graphical.codex.permission-profile";
        const id = String(profile ? message.input?.profileId : message.input?.permission);
        const option = (profile ? permissionProfiles : legacyPermissions).find(value => value.id === id);
        if (!option?.allowed) {
          this.emit({ v: 8, type: "error", code: "PREVIEW_PERMISSION", requestId: message.requestId, message: option?.reason || "预览权限选项不存在。" }); return;
        }
        this.snapshot = { ...this.snapshot, permissionProfileId: profile ? id : null,
          executionPermission: profile ? id === "audit" ? "readOnly" : "askApproval" : id as CodexConfigurationView["runtime"]["executionPermission"] };
        snapshot(message.sessionId);
        this.emit({ v: 8, type: "graphical.result", sessionId: message.sessionId, threadId: this.snapshot.threadId, requestId: message.requestId, result: { ok: true } }); return;
      }
      case "graphical.usage": this.emit({ v: 8, type: "graphical.usage", sessionId: message.sessionId, threadId: this.snapshot.threadId, requestId: message.requestId,
        usage: { provider: "codex", fetchedAt: Date.now(), primaryLimitId: "preview-limit", limits: [{ id: "preview-limit", name: "预览额度", usedPercent: 25, remainingPercent: 75, windowDurationMins: 300 }] } }); return;
      case "graphical.codex.capabilities": this.emit({ v: 8, type: "graphical.result", sessionId: message.sessionId, threadId: this.snapshot.threadId, requestId: message.requestId, result: { skills: [], apps: [], mcp: [], errors: {} } satisfies CodexSessionCapabilities }); return;
      case "graphical.submit":
        this.snapshot = { ...this.snapshot, items: [...this.snapshot.items,
          { id: crypto.randomUUID(), type: "userMessage", text: message.text },
          { id: crypto.randomUUID(), type: "agentMessage", text: `已收到模拟消息：${message.text}\n\n${longText}` }] }; snapshot(message.sessionId); ok(); return;
      case "graphical.history": this.emit({ v: 8, type: "graphical.history", sessionId: message.sessionId, threadId: this.snapshot.threadId, requestId: message.requestId, history: { data: [{ id: "preview-thread", title: "浏览器预览历史会话 · 长标题", updatedAt: Date.now() }], nextCursor: null } }); return;
      case "graphical.mode": this.snapshot = { ...this.snapshot, mode: message.mode }; snapshot(message.sessionId); ok(); return;
      case "graphical.model": this.snapshot = { ...this.snapshot, model: message.modelId }; snapshot(message.sessionId); ok(); return;
      case "graphical.effort": this.snapshot = { ...this.snapshot, effort: message.effort }; snapshot(message.sessionId); ok(); return;
      case "graphical.new-thread": this.snapshot = { ...this.snapshot, threadId: crypto.randomUUID(), items: [] }; snapshot(message.sessionId); ok(); return;
      case "graphical.resume": this.snapshot = { ...this.snapshot, threadId: message.targetThreadId }; snapshot(message.sessionId); ok(); return;
      case "graphical.interrupt": this.snapshot = { ...this.snapshot, busy: false }; snapshot(message.sessionId); ok(); return;
    }
    if ("requestId" in message) this.emit({ v: 8, type: "error", code: "PREVIEW_UNSUPPORTED", requestId: message.requestId, message: "此操作尚未提供预览模拟数据。" });
  }

  private workItem(message: Extract<ClientMessage, { type: "work-items.request" }>): unknown {
    const input = (message.input ?? {}) as Record<string, unknown>;
    if (message.operation === "listQuickPrompts") return this.prompts;
    if (message.operation === "mutateQuickPrompt") {
      const operation = input.operation;
      if (operation !== "add" && operation !== "update" && operation !== "delete") throw new Error("不支持的常用提示词操作");
      const index = this.prompts.findIndex(prompt => prompt.id === input.id);
      if (operation !== "add" && (index < 0 || this.prompts[index].version !== input.version)) throw new Error("常用提示词已修改或删除，请刷新后重试。");
      if (operation === "delete") this.prompts.splice(index, 1);
      else {
        if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 100
          || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 100000
          || (input.persistent !== undefined && typeof input.persistent !== "boolean")) throw new Error("常用提示词名称、正文或常驻设置无效。");
        const prompt: WorkItemQuickPrompt = { id: operation === "add" ? crypto.randomUUID() : this.prompts[index].id,
          version: operation === "add" ? 1 : this.prompts[index].version + 1,
          name: input.name.trim(), prompt: input.prompt, persistent: input.persistent === true };
        if (operation === "add") this.prompts.push(prompt);
        else this.prompts[index] = prompt;
      }
      this.emit({ v: 8, type: "work-items.changed" });
      return this.prompts;
    }
    if (message.operation === "list") {
      const records = this.tasks.filter(task => (!input.templateId || input.templateId === task.templateId) && (!input.ownerId || input.ownerId === task.ownerId)
        && (!Array.isArray(input.statuses) || input.statuses.includes(task.status)) && (!input.status || input.status === task.status)
        && (input.needsFollowUp === undefined || input.needsFollowUp === task.needsFollowUp)
        && (!input.keyword || `${task.taskName} ${task.output}`.includes(String(input.keyword))));
      return { records: records.slice(Number(input.page ?? 0) * 30, (Number(input.page ?? 0) + 1) * 30).map(task => ({ ...task, summary: task.output.slice(0, 160) })), total: records.length,
        templates: [{ id: "preview-agent", name: "图形助手模板" }], owners: [{ id: "preview-owner", name: "预览负责人", templateId: "preview-agent" }] };
    }
    const task = this.tasks.find(task => task.id === input.id);
    if (!task) throw new Error("预览任务不存在");
    if (message.operation === "get") return task;
    if (message.operation === "preview") return { body: { prompt: input.prompt ?? task.output }, configuration: { mode: "browser-preview", cwd } };
    if (message.operation === "listAttempts") return { records: this.attempts.filter(attempt => attempt.workItemId === task.id), total: this.attempts.filter(attempt => attempt.workItemId === task.id).length };
    if (message.operation === "getAttempt") return this.attempts.find(attempt => attempt.id === input.attemptId);
    if (input.version !== task.version) throw new Error("任务已更新，请刷新后重试");
    switch (message.operation) {
      case "execute": {
        task.status = "completed"; task.sessionId = "preview-graphical";
        const attempt: WorkItemAttempt = { id: crypto.randomUUID(), workItemId: task.id, status: "completed", startedAt: Date.now(), endedAt: Date.now(), sessionId: task.sessionId,
          input: { prompt: String(input.prompt ?? task.output) }, configuration: { mode: "browser-preview" }, output: longText, error: "" };
        this.attempts.unshift(attempt); task.latestAttemptId = attempt.id; break;
      }
      case "markCompleted": task.status = "completed"; break;
      case "setFollowUp": task.needsFollowUp = Boolean(input.needsFollowUp); break;
      case "void": task.status = "void"; task.voidReason = String(input.reason ?? ""); break;
      case "restore": case "resolveUncertain": task.status = "pending"; break;
      default: throw new Error("此任务操作尚未提供预览模拟数据");
    }
    task.version++; task.updatedAt = Date.now(); this.emit({ v: 8, type: "work-items.changed" }); return task;
  }
}

export function installBrowserPreview() {
  installPreviewTransport(() => new PreviewSocket() as unknown as RemoteSocket);
}
