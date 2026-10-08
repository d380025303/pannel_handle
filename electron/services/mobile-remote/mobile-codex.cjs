// Explicit mobile commands; never dispatch a client supplied method name.
function createMobileCodexHandlers({ graphicalService: service, codexPluginService: plugins, codexVersionService: version,
  projectSearchService: search, agentSessionLauncher: launcher, mcpConfigService: mcp, getCodexVerifiedModels }) {
  const commands = new Set(["version", "version-update", "models", "model-source", "fast-mode", "compact", "review", "goal.read", "goal.set", "goal.clear",
    "configuration", "permission-profile", "permission-legacy", "capabilities", "skill-enable", "app-detail", "plugin-detail", "plugin-skill", "mcp-resource", "mcp-login", "mcp-reload",
    "terminals", "terminal-stop", "terminals-clean", "account.read", "account.login", "account.cancel", "account.logout",
    "history.rename", "history.pin", "history.archive", "history.unarchive", "history.fork", "history.initial",
    "fork-turn", "attachment-preview", "workspace-search", "subagents", "subagent-view", "sandbox", "elicitation",
    "plugins", "plugin-install", "plugin-uninstall", "marketplace-add", "marketplace-refresh", "marketplace-remove",
    "plugin-config", "plugin-enable", "mcp-config", "mcp-save", "mcp-remove"]);
  const text = (value, limit = 4000) => {
    if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) throw new Error("参数无效。");
    return value;
  };
  const bool = value => { if (typeof value !== "boolean") throw new Error("参数无效。"); return value; };
  async function handle(message, session, current) {
    const command = message.type.slice("graphical.codex.".length);
    if (!commands.has(command)) throw new Error("该移动端操作不被允许。");
    if (session.agentProvider !== "codex" || current.provider && current.provider !== "codex") throw new Error("仅 Codex 图形会话支持此操作。");
    const id = session.id;
    const p = message.input || {};
    const idle = () => { if (!current.threadId || current.busy || current.archived || current.compacting || current.reviewing)
      throw new Error("当前会话不可执行此操作。"); };
    const scope = () => { if (!["user", "project"].includes(p.scope)) throw new Error("配置范围无效。"); return p.scope; };
    const configRequest = () => ({ provider: "codex", scope: scope(), sessionId: id,
      projectPath: service.getWorkspaceCwd(id) });
    switch (command) {
      case "configuration": return service.readConfiguration(id);
      case "permission-profile": return service.setPermissionProfile(id, text(p.profileId, 512));
      case "permission-legacy": return service.setExecutionPermission(id, text(p.permission, 512));
      case "version": return version.check(id, p.force === true);
      case "version-update": idle(); return version.update(id);
      case "models": return session.type === "ssh" ? [] : getCodexVerifiedModels?.() || [];
      case "model-source": idle(); {
        if (session.type === "ssh" || current.pendingPlan || current.approvals?.length || current.questions?.length || current.elicitations?.length) throw new Error("当前会话不可切换模型来源。");
        const source = p.source;
        if (source !== "native" && !(getCodexVerifiedModels?.() || []).some(model => model.source === source && model.id === p.modelId)) throw new Error("请选择已通过 Codex 验证的模型。");
        if (source === "native" && p.modelId && !(current.models || []).some(model => model.id === p.modelId)) throw new Error("模型无效。");
        const replacement = await launcher.switchModelSource(id, source, true, p.modelId || undefined);
        return { id: replacement.id };
      }
      case "fast-mode": idle(); if (current.backend !== "openai") throw new Error("当前后端不支持快速模式。"); return service.setFastMode(id, bool(p.enabled));
      case "compact": idle(); return service.compactThread(id);
      case "review": idle(); {
        const target = p.target;
        if (!target || !["uncommittedChanges", "baseBranch", "commit", "custom"].includes(target.type)) throw new Error("审查目标无效。");
        if (target.type !== "uncommittedChanges") text(target[target.type === "baseBranch" ? "branch" : target.type === "commit" ? "sha" : "instructions"]);
        return service.startReview(id, target);
      }
      case "goal.read": return service.getGoal(id);
      case "goal.set": {
        const changes = p.changes;
        if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("目标无效。");
        const valid = {};
        if (changes.objective !== undefined) valid.objective = text(changes.objective);
        if (changes.status !== undefined) { if (!["active", "paused"].includes(changes.status)) throw new Error("目标状态无效。"); valid.status = changes.status; }
        if (changes.tokenBudget !== undefined) { if (changes.tokenBudget !== null && (!Number.isSafeInteger(changes.tokenBudget) || changes.tokenBudget <= 0)) throw new Error("Token 预算无效。"); valid.tokenBudget = changes.tokenBudget; }
        return service.setGoal(id, valid);
      }
      case "goal.clear": return service.clearGoal(id);
      case "capabilities": return service.listCapabilities(id, p.refresh === true);
      case "skill-enable": idle(); return service.setSkillEnabled(id, text(p.path), bool(p.enabled));
      case "app-detail": return service.readAppDetail(id, text(p.appId, 512));
      case "plugin-detail": return service.readPluginDetail(id, text(p.plugin, 512), text(p.marketplace, 512));
      case "plugin-skill": return service.readPluginSkill(id, text(p.plugin, 512), text(p.marketplace, 512), text(p.skill, 512));
      case "mcp-resource": return service.readMcpResource(id, text(p.server, 512), text(p.uri));
      case "mcp-login": return service.loginMcpServer(id, text(p.name, 512));
      case "mcp-reload": return service.reloadMcpServers(id);
      case "terminals": return service.listBackgroundTerminals(id);
      case "terminal-stop": return service.terminateBackgroundTerminal(id, text(p.processId, 512));
      case "terminals-clean": return service.cleanBackgroundTerminals(id);
      case "account.read": return service.readAccount(id);
      case "account.login": if (!["chatgpt", "chatgptDeviceCode"].includes(p.type)) throw new Error("登录方式无效。"); return service.startLogin(id, p.type);
      case "account.cancel": return service.cancelLogin(id);
      case "account.logout": idle(); return service.logout(id);
      case "history.rename": return service.renameThread(id, text(p.targetThreadId, 200), text(p.name, 512));
      case "history.pin": return service.pinThread(id, text(p.targetThreadId, 200), bool(p.isPinned));
      case "history.archive": if (p.targetThreadId === current.threadId && current.busy) throw new Error("当前会话正在执行。"); return service.archiveThread(id, text(p.targetThreadId, 200));
      case "history.unarchive": return service.unarchiveThread(id, text(p.targetThreadId, 200));
      case "history.fork": idle(); return service.forkThread(id, text(p.targetThreadId, 200));
      case "history.initial": return service.readInitialUserInput(id, text(p.targetThreadId, 200));
      case "fork-turn": idle(); if (!current.items.some(item => item.turnId === p.turnId)) throw new Error("所选轮次已失效。"); return launcher.forkTurnToNewSession(id, current.threadId, text(p.turnId, 200));
      case "attachment-preview": return service.previewAttachment(id, text(p.path));
      case "workspace-search": if (!search) throw new Error("工作区搜索不可用。"); return search.searchWorkspaceEntries(id, typeof p.query === "string" ? p.query.slice(0, 512) : "");
      case "subagents": return service.refreshSubAgents(id, current.threadId);
      case "subagent-view": return service.setSubAgentView(id, bool(p.expanded), p.targetThreadId == null ? null : text(p.targetThreadId, 200), current.threadId);
      case "sandbox": if (session.type !== "windows" || !current.windowsSandboxSetup?.available || !["elevated", "unelevated"].includes(p.mode)) throw new Error("当前会话不可初始化 Windows 沙箱。"); return service.setupWindowsSandbox(id, p.mode);
      case "elicitation": if (!current.elicitations?.some(value => String(value.requestId) === String(p.requestId)) || !["accept", "decline", "cancel"].includes(p.action)) throw new Error("MCP 请求已失效。"); return service.resolveElicitation(id, p.requestId, p.action, p.content);
      case "plugins": return plugins.list(id);
      case "plugin-install": return plugins.install(id, text(p.plugin, 512), text(p.marketplace, 512));
      case "plugin-uninstall": return plugins.uninstall(id, text(p.plugin, 512), text(p.marketplace, 512));
      case "marketplace-add": return plugins.addMarketplace(id, text(p.source));
      case "marketplace-refresh": return plugins.refreshMarketplace(id, text(p.name, 512));
      case "marketplace-remove": return plugins.removeMarketplace(id, text(p.name, 512));
      case "plugin-config": return plugins.readConfig(id, scope());
      case "plugin-enable": return plugins.setEnabled(id, scope(), { plugin: text(p.plugin, 512), marketplace: text(p.marketplace, 512), enabled: bool(p.enabled) });
      case "mcp-config": return mcp.list(configRequest());
      case "mcp-save": return mcp.save({ ...configRequest(), draft: p.draft, expectedVersion: text(p.expectedVersion, 512), originalName: p.originalName });
      case "mcp-remove": return mcp.remove({ ...configRequest(), name: text(p.name, 512), expectedVersion: text(p.expectedVersion, 512) });
    }
  }
  return { handle };
}
module.exports = { createMobileCodexHandlers };
