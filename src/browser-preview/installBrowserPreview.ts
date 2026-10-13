import type {
  AppConfig,
  CodexExecutionPermission,
  CodexAppServerSnapshot,
  CodexPluginCatalog,
  CodeBuddyPluginCatalog,
  FileTransferTask,
  GitRepositorySnapshot,
  McpDocument,
  MobileAccessState,
  OpenRouterConfig,
  OpenRouterModel,
  RemoteFileEntry,
  TerminalSession
} from "../vite-env";
import { DEFAULT_TITLE_BAR_ACTION_ORDER } from "../components/app/titleBarActions";

type Listener<T> = (value: T) => void;

function createChannel<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    emit(value: T) {
      listeners.forEach((listener) => listener(value));
    },
    subscribe(listener: Listener<T>) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

const now = Date.now();
let nextId = 1;

const savedSessions: TerminalSession[] = [
  {
    id: "preview-local-template",
    title: "本地开发",
    shell: "pwsh.exe",
    cwd: "C:\\workspace\\pannel-handle",
    createdAt: now - 7_200_000,
    type: "windows",
    agentProvider: "codex",
    agentLocation: "local",
    codexBackend: "openai",
    codexModel: "gpt-5",
    tags: ["开发", "前端"],
    quickCommands: [
      { id: "quick-test", command: "pnpm test", pinned: true },
      { id: "quick-build", command: "pnpm build", pinned: true }
    ]
  },
  {
    id: "preview-wsl-template",
    title: "Ubuntu 工具链",
    shell: "wsl.exe",
    cwd: "/home/codex/project",
    createdAt: now - 3_600_000,
    type: "wsl",
    wslDistro: "Ubuntu-24.04",
    tags: ["WSL"]
  },
  {
    id: "preview-ssh-template",
    title: "测试服务器",
    shell: "ssh",
    cwd: "/srv/pannel-handle",
    createdAt: now - 1_800_000,
    type: "ssh",
    sshConfig: { host: "preview.example.test", username: "deploy", port: 22, remark: "仅为预览数据" },
    sshConnectionState: "connected",
    tags: ["SSH", "测试环境"]
  }
];

const initialConfig: AppConfig = {
  defaultWindowsShell: "pwsh",
  autoRestore: true,
  autoWorkBuddyCheckin: true,
  autoQoderCheckin: false,
  autoCollapseFileChains: true,
  debugMode: false,
  graphicalSessionMinimalMode: false,
  mobileGraphicalSessionMinimalMode: false,
  graphicalMenuSecondaryActions: {},
  desktopMascotEnabled: true,
  screenshotEnabled: true,
  screenshotShortcut: "Ctrl+Shift+A",
  titleBarActionOrder: [...DEFAULT_TITLE_BAR_ACTION_ORDER],
  titleBarHiddenActions: [],
  lastActiveSessionIds: savedSessions.map((session) => session.id),
  themeId: "dark-slate",
  locale: "zh-CN",
  sidebarWidth: 290,
  rightToolsWidth: 380,
  terminalBackgroundImage: "",
  terminalBackgroundOpacity: 40,
  terminalBackgroundBlur: 0,
  terminalBackgroundPositionX: 50,
  terminalBackgroundPositionY: 50
};

const initialTransfers: FileTransferTask[] = [
  {
    id: "preview-transfer-complete",
    sessionId: "preview-ssh-template",
    direction: "download",
    name: "release-notes.md",
    remotePath: "/srv/pannel-handle/release-notes.md",
    localPath: "C:\\Downloads\\release-notes.md",
    status: "completed",
    transferredBytes: 12_480,
    totalBytes: 12_480,
    percent: 100,
    createdAt: now - 240_000,
    updatedAt: now - 230_000
  }
];

const remoteEntries: RemoteFileEntry[] = [
  { name: "src", path: "/srv/pannel-handle/src", type: "directory", size: 0, modifiedAt: now - 60_000 },
  { name: "package.json", path: "/srv/pannel-handle/package.json", type: "file", size: 2_846, modifiedAt: now - 120_000 },
  { name: "README.md", path: "/srv/pannel-handle/README.md", type: "file", size: 6_420, modifiedAt: now - 300_000 }
];

const gitStatusFile = {
  status: " M",
  label: "Modified",
  indexStatus: " ",
  worktreeStatus: "M",
  conflicted: false,
  path: "src/App.tsx"
};

function createGitSnapshot(cwd: string): GitRepositorySnapshot {
  const status = {
    cwd,
    clean: false,
    files: [gitStatusFile],
    branch: {
      name: "feature/browser-preview",
      oid: "7d03c90",
      detached: false,
      unborn: false,
      upstream: { name: "origin/feature/browser-preview", remote: "origin", branch: "feature/browser-preview" },
      ahead: 2,
      behind: 0
    }
  };
  return {
    cwd,
    status,
    branches: {
      cwd,
      branches: [
        { name: "feature/browser-preview", kind: "local", current: true, commit: "7d03c90", relativeTime: "2 分钟前" },
        { name: "master", kind: "local", current: false, commit: "ac921fe", relativeTime: "昨天" },
        { name: "origin/master", kind: "remote", current: false, commit: "ac921fe", relativeTime: "昨天" }
      ]
    },
    remotes: { cwd, remotes: ["origin"] },
    stashes: { cwd, stashes: [{ ref: "stash@{0}", commit: "881be2a", relativeTime: "1 小时前", message: "WIP: 调整终端布局" }] },
    operationState: null
  };
}

function createRouterState(modelId: string): { config: OpenRouterConfig; models: OpenRouterModel[] } {
  return {
    config: { hasApiKey: true, fetchedAt: now },
    models: [{
      id: modelId,
      name: modelId,
      description: "浏览器预览模型",
      contextLength: 200_000,
      inputModalities: ["text", "image"],
      supportedParameters: ["tools", "reasoning"],
      pricing: { prompt: "0.000001", completion: "0.000004" },
      compatible: true,
      agentVerifications: { opencode: { status: "passed", checkedAt: now }, codebuddy: { status: "passed", checkedAt: now } },
      verification: { modelId, status: "passed", checkedAt: now }
    }]
  };
}

export function installBrowserPreview() {
  let sessions: TerminalSession[] = [];
  let previewExecutionPermission: CodexExecutionPermission = "askApproval";
  let previewSkillEnabled = true;
  let previewProfileId: string | null = null;
  let previewGoal: CodexAppServerSnapshot["goal"] = { threadId: "preview-thread", objective: "浏览器预览：检查图形会话的布局、长文本和弹窗滚动", status: "active", tokenBudget: 100000, tokensUsed: 12500, timeUsedSeconds: 240 };
  let backgroundTerminals = [{ itemId: "preview-command", processId: "preview-process", command: "pnpm test:desktop -- 浏览器预览示例（不会执行）", cwd: "C:/workspace/pannel-handle", osPid: 12345, cpuPercent: 1.2, rssKb: 24576 }];
  let pluginCatalog: CodexPluginCatalog = { environment: "浏览器预览（内存数据）", installed: [{ name: "preview-tools", displayName: "预览工具集", marketplaceName: "preview-marketplace", description: "仅用于视觉验收，包含 Skills、Apps 与 MCP 服务。", enabled: true, source: { type: "local" } }], available: [{ name: "preview-documents", marketplaceName: "preview-marketplace", description: "文档工具预览", enabled: false }], marketplaces: [{ name: "preview-marketplace", path: "C:/preview/plugins", source: "浏览器内存示例" }], errors: [] };
  const pluginOverrides: Record<string, { enabled?: boolean }> = {};
  const buddyCatalog = (): CodeBuddyPluginCatalog => ({ environment: "浏览器预览", installed: [{ id: "preview-buddy-plugin", name: "preview-tools", marketplaceName: "preview-marketplace", scope: "project", enabled: true, version: "1.0.0-preview", dependencyErrors: [] }], available: [{ name: "preview-documents", marketplaceName: "preview-marketplace", description: "浏览器预览文档工具" }], marketplaces: [{ name: "preview-marketplace", source: "C:/preview/plugins", description: "浏览器内存示例", autoUpdate: false }], errors: [] });
  const previewSnapshot = (): CodexAppServerSnapshot => ({ threadId: "preview-thread", provider: "codex", backend: "openai", windowsSandboxSetup: { available: true, mode: "unelevated", status: "idle", error: null }, effort: "medium", model: "preview-model", models: [{ id: "preview-model", displayName: "浏览器预览模型", inputModalities: ["text", "image"], fastAvailable: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "平衡速度与推理深度" }, { reasoningEffort: "high", description: "更深入的推理" }] }], mode: "default", executionPermission: previewExecutionPermission, permissionProfileId: previewProfileId, busy: false, error: null, pendingPlan: null, goal: copy(previewGoal), approvals: [], capabilities: { history: true, plan: true, attachments: true, permissions: true }, items: [
    { id: "preview-user", turnId: "preview-turn", type: "userMessage", text: "浏览器预览：检查图形会话界面，包含长路径 C:/workspace/pannel-handle/src/components/agents/CodexAppServerSession.tsx。" },
    { id: "preview-reasoning", turnId: "preview-turn", type: "reasoning", summary: ["核对主题颜色、按钮状态与内容滚动区域。"] },
    { id: "preview-command", turnId: "preview-turn", type: "commandExecution", command: "pnpm test:desktop", output: "浏览器预览输出：14 tests passed\n此命令没有实际执行。", status: "completed", durationMs: 1250 },
    { id: "preview-assistant", turnId: "preview-turn", type: "agentMessage", text: "## 浏览器预览示例\n\n会话内容用于检查 **深色石板** 主题的视觉呈现。\n\n- 菜单、弹窗与配置面板\n- 长文本换行和键盘焦点\n\n```ts\nconst preview = '仅在浏览器内存中运行';\n```", status: "completed" }
  ] });
  let library = copy(savedSessions);
  let config = copy(initialConfig);
  let transfers = copy(initialTransfers);
  let mobileState: MobileAccessState = {
    config: { enabled: true, interfaceName: "Wi-Fi", port: 43110, hasPassword: true },
    interfaces: [{ name: "Wi-Fi", address: "192.168.1.20" }],
    running: true,
    hostname: "preview-pc",
    address: "192.168.1.20",
    canonicalUrl: "http://preview-pc:43110",
    fallbackUrl: "http://192.168.1.20:43110",
    localUrl: "http://127.0.0.1:43110",
    lastError: "",
    activeConnections: [{ id: "phone-1", name: "预览手机", remoteAddress: "192.168.1.88" }]
  };
  let clipboardText = "";
  let isMaximized = false;
  let dingTalkConfig = { enabled: true, hasWebhook: true, hasSecret: true };
  let environments = [{ id: "preview-env", name: "浏览器预览", entries: [{ name: "NODE_ENV", value: "development" }], references: ["本地开发"] }];
  let launchTemplates = [{ id: "preview-launch", name: "全栈开发", sessionTemplateIds: ["preview-local-template", "preview-wsl-template"], createdAt: now, updatedAt: now }];
  let mcpDocument: McpDocument = {
    provider: "codex",
    scope: "user",
    path: "C:\\Users\\preview\\.codex\\config.toml",
    version: "preview-1",
    servers: [{ id: "preview-mcp", provider: "codex", scope: "user", name: "filesystem", enabled: true, transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], argsMasked: false, cwd: "", url: "", urlMasked: false, bearerTokenEnvVar: "", env: [], headers: [] }]
  };

  const sessionsChanged = createChannel<TerminalSession[]>();
  const terminalData = createChannel<{ id: string; data: string }>();
  const graphicalMenuChanged = createChannel<import("../utils/graphicalMenu").GraphicalMenuConfig>();
  const sizeOwnerChanged = createChannel<{ sessionId: string; owner: string; cols: number; rows: number }>();
  const mobileChanged = createChannel<MobileAccessState>();
  const transfersChanged = createChannel<FileTransferTask[]>();
  const maximizedChanged = createChannel<boolean>();
  const closeRequested = createChannel<void>();
  const ideaChanged = createChannel<Awaited<ReturnType<Window["ideaBridgeApi"]["getSnapshot"]>>>();

  const emitSessions = () => sessionsChanged.emit(copy(sessions));
  const emitTransfers = () => transfersChanged.emit(copy(transfers));
  const launch = (templates: TerminalSession[]) => {
    const launched = templates.map((template) => ({
      ...copy(template),
      id: `preview-runtime-${nextId++}`,
      templateId: template.templateId || template.id,
      createdAt: Date.now()
    }));
    sessions = [...sessions, ...launched];
    emitSessions();
    return launched;
  };
  const updateSession = (id: string, updates: Partial<TerminalSession>) => {
    sessions = sessions.map((session) => session.id === id ? { ...session, ...updates } : session);
    emitSessions();
    return copy(sessions);
  };
  const operation = (operationId?: string, cwd?: string) => Promise.resolve({ ok: true, operationId, cwd, message: "浏览器预览操作已在内存中完成" });

  const routerApi = (modelId: string): Window["openRouterApi"] => {
    const state = createRouterState(modelId);
    return {
      getConfig: async () => copy(state.config),
      listModels: async () => copy(state.models),
      refreshModels: async () => copy(state.models),
      saveApiKey: async () => ({ ...state.config, hasApiKey: true }),
      clearApiKey: async () => ({ ...state.config, hasApiKey: false }),
      test: async () => ({ ok: true }),
      verifyModels: async ({ modelIds }) => modelIds.map((id) => ({ modelId: id, status: "passed", checkedAt: Date.now() })),
      verifyAgentModels: async ({ modelIds }) => modelIds.map((id) => ({ modelId: id, status: "passed", checkedAt: Date.now() })),
    };
  };

  const terminalApi: Window["terminalApi"] = {
    listSessions: async () => copy(sessions),
    createSession: async (options = {}) => {
      const session: TerminalSession = {
        id: `preview-runtime-${nextId++}`,
        title: options.title || "新建预览会话",
        shell: options.shell || (options.type === "ssh" ? "ssh" : "pwsh.exe"),
        cwd: options.cwd || "C:\\workspace\\preview",
        createdAt: Date.now(),
        type: options.type || "windows",
        ...options
      };
      sessions = [...sessions, session];
      if (options.persist) library = [...library, { ...session, id: `preview-template-${nextId++}` }];
      emitSessions();
      return copy(session);
    },
    updateSession: async (id, updates) => updateSession(id, {
      ...updates,
      agentProvider: updates.agentProvider || undefined,
      agentLocation: updates.agentLocation || undefined,
      codexBackend: updates.codexBackend || undefined,
      codexModel: updates.codexModel || undefined,
      modelSource: updates.modelSource || undefined,
      modelId: updates.modelId || undefined,
      localAgentCwd: updates.localAgentCwd || undefined,
      codexExperimentalAcknowledged: updates.codexExperimentalAcknowledged ?? undefined
    }),
    switchAgent: async (id, provider) => {
      updateSession(id, { agentProvider: provider });
      return copy(sessions.find((session) => session.id === id)!);
    },
    switchModelSource: async (id, source) => {
      updateSession(id, { modelSource: source });
      return copy(sessions.find((session) => session.id === id)!);
    },
    openOtherSessionMode: async (id) => {
      const source = sessions.find((session) => session.id === id);
      if (!source) throw new Error("Session is not running.");
      const runtimeMode: TerminalSession["runtimeMode"] = source.runtimeMode === "app-server" ? "terminal" : "app-server";
      const opened: TerminalSession = { ...source, id: `preview-runtime-${nextId++}`, runtimeMode,
        graphicalSessionEnabled: runtimeMode === "app-server", createdAt: Date.now() };
      sessions = [...sessions, opened];
      emitSessions();
      return copy(opened);
    },
    closeSession: async (id) => { sessions = sessions.filter((session) => session.id !== id); emitSessions(); return copy(sessions); },
    reconnectSession: async (id) => { updateSession(id, { sshConnectionState: "connected" }); return copy(sessions.find((session) => session.id === id)!); },
    getHistory: async (id) => `\u001b[1;36mPannel Handle 浏览器预览\u001b[0m\r\n会话: ${sessions.find((session) => session.id === id)?.title || id}\r\n此终端不会执行真实命令。\r\nPS C:\\workspace\\pannel-handle> `,
    write: (id, data) => terminalData.emit({ id, data: data === "\r" ? "\r\nPS C:\\workspace\\pannel-handle> " : data }),
    resize: () => undefined,
    claimSize: (sessionId, cols, rows) => sizeOwnerChanged.emit({ sessionId, owner: "desktop", cols, rows }),
    onData: terminalData.subscribe,
    onExit: () => () => undefined,
    onSizeOwner: sizeOwnerChanged.subscribe,
    onAgentStatus: (callback) => {
      queueMicrotask(() => {
        const agent = sessions.find((session) => session.agentProvider);
        if (agent) callback({ id: agent.id, provider: agent.agentProvider!, status: "running", eventName: "preview", timestamp: Date.now(), activitySummary: "正在检查浏览器预览界面" });
      });
      return () => undefined;
    },
    onAgentHookDebug: () => () => undefined,
    onSessionsChanged: sessionsChanged.subscribe,
    onSessionSelectRequested: () => () => undefined,
    listWslDistros: async () => ["Ubuntu-24.04", "Debian"],
    loadSavedSessions: async () => copy(library),
    getIgnoredConfigWarnings: async id => [...(library.find(item => item.id === id)?.ignoredCodexConfigWarnings || [])],
    ignoreConfigWarning: async (id, fingerprint) => {
      const template = library.find(item => item.id === id);
      if (!template) throw new Error("会话模板不存在。");
      template.ignoredCodexConfigWarnings = [...new Set([...(template.ignoredCodexConfigWarnings || []), fingerprint])];
      window.dispatchEvent(new CustomEvent("preview-config-warnings", { detail: { templateId: id, ignored: template.ignoredCodexConfigWarnings } }));
      return [...template.ignoredCodexConfigWarnings];
    },
    onConfigWarningsChanged: callback => {
      const listener = (event: Event) => callback((event as CustomEvent<{ templateId: string; ignored: string[] }>).detail);
      window.addEventListener("preview-config-warnings", listener);
      return () => window.removeEventListener("preview-config-warnings", listener);
    },
    exportSavedSessions: async () => ({ canceled: false, ok: true, filePath: "C:\\Downloads\\pannel-handle-preview.json", exportedCount: library.length }),
    importSavedSessions: async () => ({ canceled: true }),
    launchSessions: async (templates) => copy(launch(templates)),
    deleteSavedSession: async (id) => { library = library.filter((session) => session.id !== id); return copy(library); },
    duplicateSession: async (id) => {
      const source = library.find((session) => session.id === id)!;
      const duplicated = { ...copy(source), id: `preview-template-${nextId++}`, title: `${source.title} 副本` };
      library = [...library, duplicated];
      return copy(duplicated);
    },
    duplicateRunningSession: async (id) => {
      const source = sessions.find((session) => session.id === id)!;
      return copy(launch([{ ...source, id: source.templateId || source.id, title: `${source.title} 副本` }])[0]);
    },
    reorderRunningSessions: async (orderedIds) => { sessions = orderedIds.map((id) => sessions.find((session) => session.id === id)).filter(Boolean) as TerminalSession[]; emitSessions(); return copy(sessions); },
    getConfig: async () => copy(config),
    onGraphicalMenuConfigChanged: graphicalMenuChanged.subscribe,
    setConfig: async (partial) => { config = { ...config, ...partial }; if (partial.graphicalMenuSecondaryActions) graphicalMenuChanged.emit(copy(partial.graphicalMenuSecondaryActions)); return copy(config); },
    chooseTerminalBackgroundImage: async () => ({ canceled: true as const })
  };

  const remoteFileApi: Window["remoteFileApi"] = {
    getHome: async (sessionId) => sessions.find((session) => session.id === sessionId)?.type === "ssh" ? "/home/deploy" : "C:\\workspace\\pannel-handle",
    list: async (_sessionId, remotePath) => remotePath.endsWith("/src") ? [{ name: "App.tsx", path: `${remotePath}/App.tsx`, type: "file", size: 31_220, modifiedAt: now }] : copy(remoteEntries),
    readText: async (_sessionId, remotePath) => ({ kind: "text", size: 160, content: `# ${remotePath.split(/[\\/]/).pop()}\n\n这是浏览器预览中的示例文件。\n`, version: "preview-v1", encoding: "utf-8", bom: false, eol: "lf" }),
    previewFile: async (_sessionId, remotePath) => ({ kind: "text", size: 160, content: `# ${remotePath}\n\n浏览器预览内容。\n`, version: "preview-v1", encoding: "utf-8", bom: false, eol: "lf" }),
    releasePreview: async () => true,
    writeText: async (_sessionId, _path, content) => ({ status: "saved", size: new TextEncoder().encode(content).length, version: `preview-v${nextId++}` }),
    createEntry: async (_sessionId, parentPath, name) => ({ status: "completed", path: `${parentPath}/${name}`, name }),
    moveEntry: async (_sessionId, sourcePath, targetDirectory, name) => ({ status: "completed", path: `${targetDirectory}/${name || sourcePath.split("/").pop()}`, name: name || sourcePath.split("/").pop() || "entry" }),
    chooseRoot: async () => ({ canceled: false, path: "/srv/pannel-handle" }),
    uploadFile: async (_sessionId, remoteDir) => ({ canceled: false, remotePath: `${remoteDir}/preview-upload.txt`, transferId: `preview-transfer-${nextId++}` }),
    uploadDroppedFiles: async (_sessionId, remoteDir, files) => ({ canceled: false, uploaded: Array.from(files as ArrayLike<File | string>).map((file, index) => ({ remotePath: `${remoteDir}/${typeof file === "string" ? file.split(/[\\/]/).pop() : file.name || `file-${index}`}` })) }),
    downloadFile: async (_transferId, _sessionId, remotePath) => ({ canceled: false, remotePath, localPath: `C:\\Downloads\\${remotePath.split("/").pop()}` }),
    startDownloadDrag: async (_transferId, _sessionId, remotePath) => ({ canceled: false, remotePath }),
    cancelDownload: async () => true,
    onDownloadProgress: () => () => undefined,
    openInExplorer: async () => undefined,
    deleteEntry: async () => ({ mode: "trash" }),
    watchDirectories: async () => true,
    unwatchDirectories: async () => undefined,
    onChanged: () => () => undefined,
    onWatchError: () => () => undefined
  };

  const gitSnapshot = createGitSnapshot("C:\\workspace\\pannel-handle");
  const gitApi: Window["gitApi"] = {
    getWorkspaceSnapshot: async () => ({ root: gitSnapshot.cwd, repositories: [{ cwd: gitSnapshot.cwd, name: "pannel-handle", relativePath: ".", snapshot: copy(gitSnapshot) }] }),
    getSnapshot: async () => copy(gitSnapshot),
    getStatus: async () => copy(gitSnapshot.status),
    getDiff: async (_target, request) => ({ cwd: gitSnapshot.cwd, path: request.path || "src/App.tsx", status: request.status || "M", scope: request.scope, kind: "text", rows: [{ type: "context", oldLineNumber: 1, newLineNumber: 1, oldText: "export function App() {", newText: "export function App() {" }, { type: "delete", oldLineNumber: 2, oldText: "  return null;" }, { type: "add", newLineNumber: 2, newText: "  return <MainLayout />;" }], truncated: false, capturedBytes: 184 }),
    getBranches: async () => copy(gitSnapshot.branches),
    getRemotes: async () => copy(gitSnapshot.remotes),
    checkoutBranch: (target, _branch, id) => operation(id, target.cwd),
    createBranch: (target, _branch, id) => operation(id, target.cwd),
    getStashes: async () => copy(gitSnapshot.stashes),
    getHistory: async (target) => ({ cwd: target.cwd, commits: [{ oid: "7d03c90d50", shortOid: "7d03c90", authorName: "Codex", authorEmail: "codex@example.test", authoredAt: now - 120_000, subject: "增加浏览器预览模式", decorations: ["HEAD -> feature/browser-preview"] }], hasMore: false, nextSkip: 1 }),
    stageFiles: (target, _paths, id) => operation(id, target.cwd),
    stageAll: (target, id) => operation(id, target.cwd),
    unstageFiles: (target, _paths, id) => operation(id, target.cwd),
    unstageAll: (target, id) => operation(id, target.cwd),
    discardWorkingTree: (target, _file, id) => operation(id, target.cwd),
    commit: (target, _message, id) => operation(id, target.cwd),
    fetch: (target, _remote, id) => operation(id, target.cwd),
    pull: (target, id) => operation(id, target.cwd),
    push: (target, _remote, id) => operation(id, target.cwd),
    stashChanges: (target, _message, id) => operation(id, target.cwd),
    applyStash: (target, _ref, id) => operation(id, target.cwd),
    popStash: (target, _ref, id) => operation(id, target.cwd),
    dropStash: (target, _ref, id) => operation(id, target.cwd),
    revertFile: (target, _file, id) => operation(id, target.cwd),
    cancelOperation: async () => true
  };

  const ideaSnapshot = {
    protocolVersion: 1,
    updatedAt: now,
    connections: [{ bridgeId: "preview-idea", pid: 24680, productName: "IntelliJ IDEA", productVersion: "2026.2", buildNumber: "IU-262.preview", status: "connected" as const, projects: [{ id: "preview-project", name: "pannel-handle", path: "C:\\workspace\\pannel-handle", configurations: [{ id: "preview-run", name: "Desktop Dev", type: "npm", temporary: false, allowParallel: false, supportsRun: true, supportsDebug: true, instances: [] }] }] }]
  };

  let sessionApiState = { enabled: false, running: false, port: 43125, url: "http://127.0.0.1:43125", lanUrls: [] as string[], error: "浏览器预览：查询为模拟数据，不会启动 HTTP 服务。" };
  const sessionApiChanged = createChannel<typeof sessionApiState>();
  const previewInstance = (session: TerminalSession) => ({ sessionId: session.id, title: session.title, templateId: session.templateId || null,
    runtimeMode: session.runtimeMode === "app-server" ? "app-server" : "terminal", type: session.type, agentProvider: session.agentProvider || null,
    sshConnectionState: session.type === "ssh" ? session.sshConnectionState || "connecting" : null,
    workState: "unknown", summary: "浏览器预览模拟会话", queriedAt: Date.now() });
  const apis = {
    sessionApi: {
      get: async () => copy(sessionApiState),
      configure: async input => {
        sessionApiState = { ...sessionApiState, ...input, running: input.enabled ?? sessionApiState.enabled,
          url: `http://127.0.0.1:${input.port ?? sessionApiState.port}` };
        sessionApiChanged.emit(copy(sessionApiState)); return copy(sessionApiState);
      },
      revealToken: async () => "PREVIEW_TOKEN",
      resetToken: async () => "PREVIEW_TOKEN",
      onChanged: sessionApiChanged.subscribe,
      invoke: async input => {
        if (!sessionApiState.running) throw new Error("接口服务未启用。");
        if (input.operation === "create") throw new Error("浏览器预览不支持真实创建；请在 Electron 中验证。");
        const instance = input.operation === "getInstanceStatus" ? sessions.find(item => item.id === input.sessionId?.trim()) : undefined;
        const endpoint = input.operation === "list" ? "session-templates" : `session-instances${input.operation === "getInstanceStatus" ? `/${encodeURIComponent(input.sessionId?.trim() || "")}` : ""}`;
        const body = input.operation === "list" ? { templates: savedSessions.filter(item => item.agentProvider).map(item => ({ templateId: item.id, title: item.title,
          agentProvider: item.agentProvider, type: item.type, graphicalSessionEnabled: Boolean(item.graphicalSessionEnabled), modelSource: "native", modelId: null })) }
          : input.operation === "listInstances" ? { sessions: sessions.map(previewInstance) }
          : instance ? previewInstance(instance) : { error: { code: "session_not_found", message: "会话实例不存在或已经结束。" } };
        return { method: "GET", url: `${sessionApiState.url}/api/v1/${endpoint}`, status: input.operation === "getInstanceStatus" && !instance ? 404 : 200, elapsedMs: 0, body };
      }
    } satisfies Window["sessionApi"],
    environmentApi: {
      list: async () => copy(environments),
      save: async (input) => { const entry = { id: input.id || `preview-env-${nextId++}`, name: input.name, entries: input.entries, references: [] }; environments = [...environments.filter((item) => item.id !== entry.id), entry]; return copy(environments); },
      delete: async (id) => { environments = environments.filter((item) => item.id !== id); return copy(environments); },
      preview: async (input) => (input.environmentOverrides || []).map((entry) => ({ ...entry, source: "会话覆盖" }))
    } satisfies Window["environmentApi"],
    terminalApi,
    screenshotApi: { captureRegion: async () => ({ status: "launched" }) } satisfies Window["screenshotApi"],
    openRouterApi: routerApi("openai/gpt-5"),
    naraRouterApi: routerApi("nvidia/llama-3.3-nemotron-super-49b-v1"),
    miniMaxApi: {
      ...routerApi("MiniMax-M2.5"),
      getUsage: async () => ({
        provider: "minimax" as const,
        fetchedAt: Date.now(),
        primaryLimitId: "MiniMax-M2.5:interval",
        limits: [{ id: "MiniMax-M2.5:interval", name: "MiniMax-M2.5 · 5 小时", usedPercent: 25, remainingPercent: 75 }]
      })
    } satisfies Window["miniMaxApi"],
    agentConversationApi: {
      setActiveSession: () => undefined,
      getSnapshot: async () => ({ activeSessionId: sessions[0]?.id || null, turn: sessions[0] ? { sessionId: sessions[0].id, sessionTitle: sessions[0].title, provider: "codex", status: "running", supported: true, messages: [{ id: "preview-message-1", provider: "codex", kind: "user", text: "请检查浏览器预览界面。", timestamp: now - 30_000 }, { id: "preview-message-2", provider: "codex", kind: "commentary", text: "正在核对布局和交互状态。", timestamp: now - 20_000 }] } : null }),
      listHistory: async ({ source }) => ({ items: [{ ref: source === "archive" ? "archive:00000000-0000-0000-0000-000000000001" : "preview-conversation", provider: "codex", title: "浏览器预览验证", preview: "检查布局和交互状态", cwd: "C:\\workspace\\pannel-handle", createdAt: now - 86_400_000, updatedAt: now, archived: false }], nextCursor: null, errors: [] }),
      getHistoryMessages: async ({ conversationRef }) => ({ conversationRef, messages: [{ id: "preview-history-message", provider: "codex", kind: "final", text: "预览数据加载完成。", timestamp: now }], nextCursor: null }),
      openExternal: async () => ({ ok: true }),
      onAppend: () => () => undefined,
      onSnapshot: () => () => undefined
    } satisfies Window["agentConversationApi"],
    openCodeAuthApi: { start: async () => ({ generation: 1, history: "浏览器预览认证终端，不会连接真实账号。\r\n", seq: 1 }), cancel: async () => undefined, write: () => undefined, resize: () => undefined, onData: () => () => undefined, onState: () => () => undefined } satisfies Window["openCodeAuthApi"],
    codeBuddyPluginApi: {
      list: async () => buddyCatalog(), reload: async () => buddyCatalog(), install: async () => buddyCatalog(), uninstall: async () => buddyCatalog(), enable: async () => buddyCatalog(), disable: async () => buddyCatalog(), update: async () => buddyCatalog(), addMarketplace: async () => buddyCatalog(), refreshMarketplace: async () => buddyCatalog(), removeMarketplace: async () => buddyCatalog(), setAutoUpdate: async () => buddyCatalog()
    } satisfies Window["codeBuddyPluginApi"],
    codeBuddyMcpApi: {
      runtime: async () => ({ threadId: "preview-thread", supported: true, reason: "浏览器预览", statuses: [{ name: "filesystem", status: "connected", error: null, updatedAt: now }] }),
      restart: async () => ({ ...previewSnapshot(), provider: "codebuddy" }), images: async () => [],
      load: async () => ({ toolName: "preview", html: "<p>浏览器预览 MCP App</p>" }), read: async (_id, _thread, _item, uri) => ({ contents: [{ uri, text: "浏览器预览 MCP 资源", mimeType: "text/plain" }] }),
      prepare: async (_id, _thread, _item, name, args) => ({ token: "preview-token", serverName: "filesystem", toolName: name, arguments: args }), resolve: async () => ({ content: [{ type: "text", text: "浏览器预览结果" }] }), dispose: async () => undefined
    } satisfies Window["codeBuddyMcpApi"],
    codeBuddyVersionApi: { check: async () => ({ status: "available", currentVersion: "1.0.0-preview", latestVersion: "1.1.0-preview", method: "npm", environment: "windows" }), update: async () => ({ status: "current", currentVersion: "1.1.0-preview", latestVersion: "1.1.0-preview", method: "npm", environment: "windows", restartRequired: true }) } satisfies Window["codeBuddyVersionApi"],
    codexPluginApi: {
      list: async () => copy(pluginCatalog),
      readConfig: async () => ({ overrides: copy(pluginOverrides) }),
      setEnabled: async (_id, _scope, input) => { const pluginId = `${input.plugin}@${input.marketplace}`; pluginOverrides[pluginId] = { enabled: input.enabled }; pluginCatalog.installed = pluginCatalog.installed.map(item => item.name === input.plugin ? { ...item, enabled: input.enabled } : item); return { pluginId, enabled: input.enabled, overrides: copy(pluginOverrides) }; },
      install: async (_id, name, marketplace) => { pluginCatalog.installed.push({ name, marketplaceName: marketplace, enabled: true, description: "浏览器预览安装" }); return copy(pluginCatalog); },
      uninstall: async (_id, name) => { pluginCatalog.installed = pluginCatalog.installed.filter(item => item.name !== name); return copy(pluginCatalog); },
      addMarketplace: async (_id, source) => { pluginCatalog.marketplaces.push({ name: source, path: source }); return copy(pluginCatalog); },
      refreshMarketplace: async () => copy(pluginCatalog),
      removeMarketplace: async (_id, name) => { pluginCatalog.marketplaces = pluginCatalog.marketplaces.filter(item => item.name !== name); return copy(pluginCatalog); }
    } satisfies Window["codexPluginApi"],
    codexAppServerApi: {
      readConfiguration: async () => ({ config: { status: "ready" as const, data: { values: { model: "preview-model", model_reasoning_effort: "medium", features: { skills: true }, approval_policy: "on-request" }, layers: [{ type: "project", path: "C:/workspace/pannel-handle/.codex/config.toml", disabled: false, values: { model: "preview-model" } }] } }, requirements: { status: "ready" as const, data: { allowedApprovalPolicies: ["on-request", "never"] } }, profiles: { status: "ready" as const, data: [{ id: "preview-workspace", allowed: true, reason: null, description: "浏览器预览：工作区权限档" }, { id: "preview-restricted", allowed: false, reason: "浏览器预览禁用状态示例" }] }, legacy: ["readOnly", "askApproval", "fullAccess"].map(id => ({ id, allowed: true, reason: null })), cwd: "C:/workspace/pannel-handle（浏览器预览）", runtime: { model: "preview-model", effort: "medium", executionPermission: previewExecutionPermission, permissionProfileId: previewProfileId, mode: "default" } }),
      setPermissionProfile: async (_id: string, profileId: string) => { previewProfileId = profileId; return previewSnapshot(); },

      setSubAgentView: async () => undefined,
      refreshSubAgents: async () => undefined,
      setupWindowsSandbox: async (_id, mode) => ({ ...previewSnapshot(), windowsSandboxSetup: { available: true, mode, status: "succeeded", error: null } }),
      snapshot: async id => {
        const provider = sessions.find(session => session.id === id)?.agentProvider;
        const result: CodexAppServerSnapshot = { ...previewSnapshot(), provider: provider === "codebuddy" || provider === "opencode" ? provider : "codex",
          windowsSandboxSetup: { available: true, mode: "unelevated", status: "idle", error: null }, effort: "medium",
          nativeMode: "build", nativeModes: [{ id: "build", name: "构建", description: "浏览器预览默认模式" }, { id: "plan", name: "规划", description: "浏览器预览规划模式" }],
          acpOptions: [{ id: "effort", name: "推理强度", type: "select", currentValue: "medium", options: [{ value: "medium", name: "中" }, { value: "high", name: "高" }] }],
          availableCommands: [{ name: "preview", description: "浏览器预览命令" }] };
        const scene = new URLSearchParams(window.location.search).get("scene");
        if (scene === "question") result.questions = [{ requestId: "preview-question", submitting: false, params: { threadId: "preview-thread", turnId: "preview-turn", questions: [
          { id: "theme", header: "主题验收", question: "浏览器预览：选择需要检查的界面区域。", isOther: true, options: [{ label: "会话区域", description: "检查消息、推理和工具输出的布局。" }, { label: "更多操作", description: "检查菜单与弹窗的主题和滚动。" }] },
          { id: "details", header: "补充说明", question: "浏览器预览：还有哪些长文本布局需要检查？", required: false }
        ] } }];
        if (scene === "approval") result.approvals = [{ requestId: "preview-approval", method: "item/commandExecution/requestApproval", params: { command: "pnpm test:desktop（浏览器预览，不执行）", cwd: "C:/workspace/pannel-handle", reason: "浏览器预览：检查审批控件及长命令换行。", availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] } }];
        if (scene === "plan") { result.mode = "plan"; result.pendingPlan = { itemId: "preview-plan" }; result.items.push({ id: "preview-plan", type: "plan", turnId: "preview-turn", text: "# 浏览器预览计划\n\n1. 检查会话区域布局。\n2. 检查更多操作及内部弹窗。\n3. 完成深色石板主题视觉验收。" }); }
        if (scene === "team") { result.provider = "codebuddy"; result.team = { name: "浏览器预览团队", isAutoTeam: false, hasLiveMembers: true, members: [{ name: "界面检查", description: "浏览器预览成员", status: "completed", items: [{ id: "preview-team-message", type: "agentMessage", text: "浏览器预览：已检查菜单布局。" }], tokenUsage: { inputTokens: 2400, outputTokens: 800 }, toolCallCount: 3 }] }; }
        if (scene === "subagents") result.subAgents = { expanded: true, selectedThreadId: "preview-child", loading: false, error: null, warning: null, members: [{ threadId: "preview-child", parentThreadId: "preview-thread", name: "界面检查", role: "worker", task: "浏览器预览：检查图形会话主题", status: "completed", createdAt: now, loading: false, error: null, items: [{ id: "preview-child-message", type: "agentMessage", text: "浏览器预览：已核对更多操作区域的主题控件。" }] }] };
        return result;
      },
      listModelMetadata: async () => [],
      readAccount: async () => ({ status: "signedOut", requiresOpenaiAuth: true, account: null, login: null, rateLimits: null, usage: null, rateLimitsError: null, usageError: null, error: null }),
      startLogin: async () => ({ status: "signedOut", requiresOpenaiAuth: true, account: null, login: { type: "chatgpt", loginId: "preview", url: "https://example.com" }, rateLimits: null, usage: null, rateLimitsError: null, usageError: null, error: null }),
      cancelLogin: async () => ({ status: "signedOut", requiresOpenaiAuth: true, account: null, login: null, rateLimits: null, usage: null, rateLimitsError: null, usageError: null, error: null }),
      logout: async () => ({ status: "signedOut", requiresOpenaiAuth: true, account: null, login: null, rateLimits: null, usage: null, rateLimitsError: null, usageError: null, error: null }),
      refreshAccountUsage: async () => ({ status: "signedOut", requiresOpenaiAuth: true, account: null, login: null, rateLimits: null, usage: null, rateLimitsError: null, usageError: null, error: null }),
      listHistory: async (_id, _cursor, archived) => ({ data: [{ id: "preview-history", title: "浏览器预览：图形会话界面验收与长文本滚动检查", updatedAt: Math.floor((now - 3600000) / 1000), source: "browser-preview", status: "idle", archived: Boolean(archived), isPinned: true }], nextCursor: null }),
      readInitialUserInput: async () => null,
      revertThread: async () => { throw new Error("预览模式不支持 OpenCode 回退。"); },
      restoreThread: async () => { throw new Error("预览模式不支持 OpenCode 恢复。"); },
      rewind: async () => { throw new Error("预览模式不支持 CodeBuddy 回退。"); },
      setSkillEnabled: async (_id, path, enabled) => {
        if (path !== "C:/preview/skills/ui-review/SKILL.md" || typeof enabled !== "boolean") throw new Error("无效的技能设置。");
        previewSkillEnabled = enabled;
      },
      listCapabilities: async () => ({ skills: [{ name: "ui-review", path: "C:/preview/skills/ui-review/SKILL.md", description: "检查界面", enabled: previewSkillEnabled, scope: "user" }],
        apps: [{ id: "github", name: "GitHub", description: "代码托管", accessible: true, enabled: true, callable: true }],
        mcp: [{ name: "filesystem", status: "connected", authStatus: "unsupported", toolsError: null,
          resources: [{ uri: "preview://readme", name: "浏览器预览说明", description: "用于资源详情视觉验收", mimeType: "text/markdown" }], resourceTemplates: [{ uriTemplate: "preview://files/{path}", name: "预览文件", description: "内存模板" }], tools: [{ name: "read_file", description: "读取文件（浏览器预览，不会访问真实文件）" }] }], errors: {} }),
      readPluginDetail: async (_id, name, marketplace) => ({ name, marketplaceName: marketplace, description: "浏览器预览插件详情，所有数据仅保存在内存中。", version: "1.0.0-preview", source: { type: "local" }, installed: true, enabled: true, shareUrl: null, remotePluginId: "preview-plugin", skills: [{ name: "ui-review", description: "检查界面布局、主题和滚动区域", enabled: true }], apps: [{ name: "GitHub 预览" }], mcpServers: ["filesystem"] }),
      readPluginSkill: async () => ({ contents: "# ui-review（浏览器预览）\n\n检查深色石板主题的控件状态、长文本换行与弹窗滚动。\n\n" + "浏览器预览示例说明。\n".repeat(35), truncated: false }),
      readAppDetail: async (_id, id) => ({ id, name: "GitHub 预览", description: "浏览器内存示例，不连接真实账号。", accessible: true, enabled: true, callable: true, distributionChannel: "browser-preview", installUrl: null, pluginDisplayNames: ["预览工具集"], tools: [{ name: "read_issue", title: "读取预览任务", description: "显示静态预览信息", enabled: true, disabledReason: null, readOnly: true }] }),
      readMcpResource: async (_id, _server, uri) => ({ contents: [{ uri, mimeType: "text/markdown", text: "# 浏览器预览资源\n\n这是一段用于检查详情布局的内存文本。", binary: false, truncated: false }], truncated: false }),
      loginMcpServer: async () => ({ authorizationUrl: "https://example.com/oauth" }),
      reloadMcpServers: async () => undefined,
      resume: async (_id, threadId) => ({ ...previewSnapshot(), threadId }),
      newThread: async () => ({ ...previewSnapshot(), threadId: `preview-thread-${nextId++}` }),
      renameThread: async () => undefined,
      pinThread: async (_id, _threadId, isPinned) => ({ isPinned }),
      deleteThread: async () => { throw new Error("预览模式不支持删除会话。"); },
      forkTurnToNewSession: async () => { throw new Error("预览模式不支持从此回合新建会话。"); },
      forkThread: async () => ({ ...previewSnapshot(), threadId: `preview-thread-${nextId++}` }),
      archiveThread: async () => undefined,
      unarchiveThread: async () => undefined,
      compactThread: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, compactionStatus: "completed", error: null, pendingPlan: null, items: [], approvals: [] }),
      startReview: async () => { throw new Error("预览模式不支持代码审查。"); },
      listBackgroundTerminals: async () => copy(backgroundTerminals),
      askSideQuestion: async () => { throw new Error("预览模式不支持旁问。"); },
      cancelSideQuestion: async () => { throw new Error("预览模式不支持旁问。"); },
      listScheduledTasks: async () => [{ id: "preview-task", cron: "0 9 * * 1-5", prompt: "浏览器预览：检查界面状态", recurring: true, durable: false, enabled: true, createdAt: now }],
      createScheduledTask: async () => undefined,
      deleteScheduledTask: async () => undefined,
      listJobs: async () => [{ id: "preview-job", cwd: "C:/workspace/pannel-handle", name: "浏览器预览后台任务", prompt: "检查深色石板主题", state: "completed", alive: false, settled: true, createdAt: now }],
      jobDispatchContext: async () => ({ cwd: "C:/workspace/pannel-handle", agents: [{ name: "preview-agent", description: "浏览器预览智能体" }] }),
      listResumableJobs: async () => [{ sessionId: "preview-job-session", cwd: "C:/workspace/pannel-handle", title: "浏览器预览历史任务", updatedAt: now }],
      dispatchJob: async () => ({ id: "preview-job", message: "浏览器预览：未执行真实任务" }),
      resumeJob: async () => ({ id: "preview-job", message: "浏览器预览：未恢复真实任务" }),
      jobTranscript: async () => ({ sessionId: "preview-job-session", updates: [{ type: "agentMessage", text: "浏览器预览后台任务记录。" }] }),
      jobAction: async () => ({ ok: true, message: "浏览器预览内存操作" }),
      watchJob: async () => undefined,
      unwatchJob: async () => undefined,
      onJobsEvent: () => () => undefined,
      onJobTranscript: () => () => undefined,
      terminateBackgroundTerminal: async (_id, processId) => { backgroundTerminals = backgroundTerminals.filter(item => item.processId !== processId); return { terminated: true }; },
      cleanBackgroundTerminals: async () => { backgroundTerminals = []; },
      getGoal: async () => previewSnapshot(),
      setGoal: async (_id, changes) => { previewGoal = { ...previewGoal, threadId: "preview-thread", objective: changes.objective || previewGoal?.objective || "浏览器预览目标", status: changes.status || "active", tokenBudget: changes.tokenBudget }; return previewSnapshot(); },
      clearGoal: async () => { previewGoal = null; return previewSnapshot(); },
      refreshGoal: async () => previewSnapshot(),
      setMode: async (_id, mode) => ({ ...previewSnapshot(), mode }),
      setNativeMode: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      setModel: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      listMainAgents: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      setMainAgent: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      setContextWindow: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      sendTeamMessage: async () => undefined,
      setEffort: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      setFastMode: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      setMultitask: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      setExecutionPermission: async (_id, permission) => { previewExecutionPermission = permission; previewProfileId = null; return previewSnapshot(); },
      dismissPlan: async () => ({ threadId: "preview-thread", mode: "plan", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      executePlan: async () => undefined,
      chooseFiles: async () => [],
      previewAttachment: async () => ({ kind: "unsupported" }),
      pasteImage: async () => ({ status: "no_image" }),
      discardImage: async () => undefined,
      submit: async () => undefined,
      interrupt: async () => undefined,
      resolveApproval: async () => undefined,
      answerQuestion: async () => undefined,
      cancelQuestion: async () => undefined,
      resolveElicitation: async () => undefined,
      onChanged: () => () => undefined,
      onDelta: () => () => undefined
    } satisfies Window["codexAppServerApi"],
    codexWorkspaceTrustApi: {
      listPending: async () => [],
      trustProject: async () => { throw new Error("浏览器预览不支持工作区信任操作。"); },
      openHooks: async () => { throw new Error("浏览器预览不支持启动 Codex Hook 终端。"); },
      write: async () => { throw new Error("浏览器预览没有 Hook 终端。"); },
      resize: async () => undefined,
      finish: async () => false,
      cancel: async () => false,
      onChanged: () => () => undefined,
      onOutput: () => () => undefined,
      onResolved: () => () => undefined
    } satisfies Window["codexWorkspaceTrustApi"],
    codexVersionApi: {
      check: async () => ({ status: "available", currentVersion: "0.156.0", latestVersion: "0.157.0", method: "npm", environment: "windows" }),
      update: async () => ({ status: "current", currentVersion: "0.157.0", latestVersion: "0.157.0", method: "npm", environment: "windows", restartRequired: true })
    } satisfies Window["codexVersionApi"],
    openCodeVersionApi: {
      check: async () => ({ status: "available", currentVersion: "2.0.18", latestVersion: "2.0.19", method: "npm", environment: "windows" }),
      update: async () => ({ status: "current", currentVersion: "2.0.19", latestVersion: "2.0.19", method: "npm", environment: "windows", restartRequired: true })
    } satisfies Window["openCodeVersionApi"],
    launchTemplateApi: {
      list: async () => copy(launchTemplates),
      create: async (input) => { const entry = { id: `preview-launch-${nextId++}`, ...input, createdAt: Date.now(), updatedAt: Date.now() }; launchTemplates = [...launchTemplates, entry]; return copy(entry); },
      update: async (id, input) => { launchTemplates = launchTemplates.map((item) => item.id === id ? { ...item, ...input, updatedAt: Date.now() } : item); return copy(launchTemplates.find((item) => item.id === id)!); },
      delete: async (id) => { launchTemplates = launchTemplates.filter((item) => item.id !== id); return copy(launchTemplates); },
      launch: async (id) => { const template = launchTemplates.find((item) => item.id === id); const selected = library.filter((session) => template?.sessionTemplateIds.includes(session.id)); return { launchedSessionIds: launch(selected).map((session) => session.id), failures: [] }; }
    } satisfies Window["launchTemplateApi"],
    mobileAccessApi: {
      getState: async () => copy(mobileState),
      updateConfig: async (partial) => { mobileState = { ...mobileState, config: { ...mobileState.config, ...partial }, running: partial.enabled ?? mobileState.running }; mobileChanged.emit(copy(mobileState)); return copy(mobileState); },
      setPassword: async () => { mobileState = { ...mobileState, config: { ...mobileState.config, hasPassword: true }, activeConnections: [] }; mobileChanged.emit(copy(mobileState)); return copy(mobileState); },
      listAudit: async () => [{ id: "preview-audit", at: now, type: "connected", deviceId: "phone-1", deviceName: "预览手机", remoteAddress: "192.168.1.88" }],
      disconnectConnection: async (connectionId) => { mobileState = { ...mobileState, activeConnections: mobileState.activeConnections.filter((item) => item.id !== connectionId) }; mobileChanged.emit(copy(mobileState)); return copy(mobileState); },
      onStateChanged: mobileChanged.subscribe
    } satisfies Window["mobileAccessApi"],
    hookConfigApi: {
      selectProjectDirectory: async (defaultPath) => ({ canceled: false, path: defaultPath || "C:\\workspace\\pannel-handle" }),
      inspect: async (_target, providers) => ({ ok: true, projectPath: "C:\\workspace\\pannel-handle", providers: Object.fromEntries(providers.map((provider) => [provider, { status: "installed", scriptPath: `.codex/${provider}-hook.sh`, managedHookCount: 1, expectedHookCount: 1 }])) }),
      install: async (_target, providers) => ({ ok: true, projectPath: "C:\\workspace\\pannel-handle", providers: Object.fromEntries(providers.map((provider) => [provider, { status: "installed", scriptPath: `.codex/${provider}-hook.sh`, managedHookCount: 1, expectedHookCount: 1 }])) })
    } satisfies Window["hookConfigApi"],
    dingTalkApi: {
      getConfig: async () => copy(dingTalkConfig),
      setConfig: async (input) => { dingTalkConfig = { ...dingTalkConfig, ...input, hasWebhook: Boolean(input.webhook) || dingTalkConfig.hasWebhook, hasSecret: Boolean(input.secret) || dingTalkConfig.hasSecret }; return copy(dingTalkConfig); },
      clearCredentials: async () => { dingTalkConfig = { enabled: false, hasWebhook: false, hasSecret: false }; return copy(dingTalkConfig); },
      test: async () => ({ ok: true })
    } satisfies Window["dingTalkApi"],
    clipboardApi: {
      writeText: async (text) => { clipboardText = text; return true; },
      readText: async () => clipboardText,
      pasteImageToSession: async () => ({ status: "no_image" }),
      uploadImageToSession: async () => ({ status: "canceled" })
    } satisfies Window["clipboardApi"],
    externalLinkApi: { open: async () => undefined } satisfies Window["externalLinkApi"],
    remoteFileApi,
    remoteSystemApi: {
      getMetrics: async () => ({ sampledAt: Date.now(), network: { receivedBytesPerSecond: 1_240_000, transmittedBytesPerSecond: 280_000 }, memory: { usedBytes: 6_442_450_944, totalBytes: 17_179_869_184 }, cpu: { usedPercent: 37.5 }, disks: [{ filesystem: "/dev/sda1", type: "ext4", mountPoint: "/", usedBytes: 53_687_091_200, totalBytes: 128_849_018_880, availableBytes: 75_161_927_680, usedPercent: 41.7, io: { busyPercent: 4.2, readBytesPerSecond: 820_000, writeBytesPerSecond: 240_000 } }] })
    } satisfies Window["remoteSystemApi"],
    skillsApi: { read: async (_provider, id) => ({ id, name: "ui-review", description: "检查界面", path: "C:/preview/skills/ui-review/SKILL.md", source: "personal", enabled: true, content: "# UI Review\n\n检查布局、交互和可访问性。" }), list: async (provider) => ({ skills: [
      { id: `${provider}-ui-review`, name: "UI Review", description: "检查桌面界面的布局、一致性和可访问性。", path: "C:\\preview\\ui-review\\SKILL.md", source: "personal", enabled: true },
      { id: `${provider}-release`, name: "Release", description: "生成并验证桌面应用发布产物。", path: "C:\\preview\\release\\SKILL.md", source: "system", enabled: true }
    ], pluginStatus: provider === "codex" ? "requires-session" : "not-applicable",
    projectStatus: provider === "codex" ? "no-session" : "not-applicable" }) } satisfies Window["skillsApi"],
    mcpApi: {
      list: async (request) => ({ ...copy(mcpDocument), provider: request.provider, scope: request.scope }),
      reveal: async (request) => ({ status: request.expectedVersion === mcpDocument.version ? "revealed" : "conflict", ...(request.expectedVersion === mcpDocument.version ? { value: "preview-secret" } : {}) } as Awaited<ReturnType<Window["mcpApi"]["reveal"]>>),
      save: async (request) => { if (request.expectedVersion !== mcpDocument.version) return { status: "conflict" }; const summary = { ...request.draft, id: request.originalName || `preview-mcp-${nextId++}`, provider: request.provider, scope: request.scope }; mcpDocument = { ...mcpDocument, provider: request.provider, scope: request.scope, version: `preview-${nextId++}`, servers: [...mcpDocument.servers.filter((server) => server.name !== request.originalName), summary] }; return { status: "saved", document: copy(mcpDocument), serverName: request.draft.name }; },
      remove: async (request) => { if (request.expectedVersion !== mcpDocument.version) return { status: "conflict" }; mcpDocument = { ...mcpDocument, version: `preview-${nextId++}`, servers: mcpDocument.servers.filter((server) => server.name !== request.name) }; return { status: "removed", document: copy(mcpDocument) }; },
      copy: async () => ({ status: "exists" })
    } satisfies Window["mcpApi"],
    agentUsageApi: {
      getUsage: async () => ({ provider: "codex", fetchedAt: Date.now(), primaryLimitId: "five-hour", limits: [{ id: "five-hour", name: "5 小时用量", usedPercent: 32, remainingPercent: 68, windowDurationMins: 300, resetsAt: now + 10_800_000 }] }),
      getCodeBuddyUsage: async () => ({ provider: "codebuddy", fetchedAt: Date.now(), primaryLimitId: "base", summary: { kind: "credits", total: 1000, used: 320, remaining: 680, usedPercent: 32, remainingPercent: 68, unit: "Credits" }, limits: [{ id: "base", name: "基础额度", category: "base", totalAmount: 1000, usedAmount: 320, remainingAmount: 680, usedPercent: 32, remainingPercent: 68, unit: "Credits", expiresAt: now + 10_800_000 }] }),
      getCodexUsage: async () => ({ provider: "codex", fetchedAt: Date.now(), primaryLimitId: "five-hour", limits: [{ id: "five-hour", name: "5 小时用量", usedPercent: 32, remainingPercent: 68, windowDurationMins: 300, resetsAt: now + 10_800_000 }] }),
      consumeResetCredit: async () => ({ outcome: "nothingToReset" }),
      cancel: () => undefined,
      cancelCodeBuddyUsage: () => undefined,
      cancelCodexUsage: () => undefined
    } satisfies Window["agentUsageApi"],
    qoderCheckinApi: {
      getStatus: async () => ({ accountId: "preview", accountLabel: "Preview desktop account", active: true, claimable: false, todayCheckedIn: true, dailyCredit: 100, windowStart: Date.now(), nextClaimAt: Date.now() + 86400000 }),
      claim: async () => ({ alreadyCheckedIn: true, status: { accountId: "preview", accountLabel: "Preview desktop account", active: true, claimable: false, todayCheckedIn: true, dailyCredit: 100, windowStart: Date.now(), nextClaimAt: Date.now() + 86400000 } })
    } satisfies Window["qoderCheckinApi"],
    workBuddyCheckinApi: {
      getStatus: async () => ({ active: true, todayCheckedIn: true, streakDays: 6, dailyCredit: 10, todayCredit: 10, totalCredits: 280, weekProgress: [true, true, true, true, true, true, false] }),
      claim: async () => ({ alreadyCheckedIn: true, status: { active: true, todayCheckedIn: true, streakDays: 6, dailyCredit: 10, todayCredit: 10, totalCredits: 280, weekProgress: [true, true, true, true, true, true, false] } })
    } satisfies Window["workBuddyCheckinApi"],
    agentTokenStatsApi: {
      getDashboard: async (options) => { const tokens = { inputTokens: 48_000, cachedInputTokens: 12_000, cacheWriteInputTokens: 0, outputTokens: 8_000, reasoningOutputTokens: 2_400, totalTokens: 58_400 }; return { generatedAt: Date.now(), range: options?.range || "7d", provider: options?.provider || "all", summary: { sessionCount: 3, averageTokens: 19_467, skillCalls: 4, mcpCalls: 7, tokens }, dailyTrend: [{ date: new Date(now).toISOString().slice(0, 10), tokens }], providerBreakdown: [{ provider: "codex", sessionCount: 3, tokens }], topSkills: [{ name: "UI Review", count: 4 }], topMcpServers: [{ name: "filesystem", count: 7, tools: [{ name: "read_file", count: 7 }] }], sessions: [], totalCount: 3, offset: options?.offset || 0, limit: options?.limit || 20 }; },
      getLive: async (sessionId) => ({ panelSessionId: sessionId, provider: "codex", state: "generating", tokens: { inputTokens: 12_000, cachedInputTokens: 4_000, cacheWriteInputTokens: 0, outputTokens: 1_800, reasoningOutputTokens: 600, totalTokens: 14_400 }, capabilities: { skills: { availability: "available", totalCalls: 2, items: [{ name: "UI Review", count: 2 }] }, mcp: { availability: "available", totalCalls: 3, servers: [{ name: "filesystem", count: 3, tools: [{ name: "read_file", count: 3 }] }] } }, turnOutputTokens: 320, outputTokensPerSecond: 18.4, models: ["gpt-5"], updatedAt: Date.now() }),
      clear: async () => true,
      onChanged: () => () => undefined,
      onLiveChanged: () => () => undefined
    } satisfies Window["agentTokenStatsApi"],
    postgresBackupApi: {
      getConfig: async () => ({ deviceId: "preview-device", deviceName: "预览电脑", enabled: false, host: "", port: 5432, database: "", user: "", ssl: true, hasPassword: false, hasPassphrase: false, lastSuccessAt: null, lastError: "", pendingSources: [], running: false }),
      saveConfig: async (input) => ({ deviceId: "preview-device", deviceName: input.deviceName || "预览电脑", enabled: input.enabled === true, host: input.host || "", port: input.port || 5432, database: input.database || "", user: input.user || "", ssl: input.ssl !== false, hasPassword: Boolean(input.password), hasPassphrase: Boolean(input.passphrase), lastSuccessAt: null, lastError: "", pendingSources: [], running: false }),
      testConnection: async () => ({ ok: false, error: "浏览器预览无法连接 PostgreSQL" }),
      run: async () => { throw new Error("浏览器预览无法执行备份"); },
      listDevices: async () => [],
      getDashboard: async () => { throw new Error("浏览器预览没有远端统计"); },
      listSnapshots: async () => [],
      restore: async () => { throw new Error("浏览器预览无法恢复会话"); },
      listConversations: async () => [],
      getMessages: async () => [],
      deleteDevice: async () => false,
      onChanged: () => () => undefined
    } satisfies Window["postgresBackupApi"],
    remoteAgentApi: {
      listAudit: async (sessionId) => [{ sessionId, timestamp: now, operationId: "preview-op", kind: "operation", tool: "read_file", status: "completed", summary: "读取示例文件" }],
      listPendingApprovals: async () => [],
      resolveApproval: async () => true,
      onAudit: () => () => undefined,
      onApprovalRequested: () => () => undefined,
      onApprovalResolved: () => () => undefined
    } satisfies Window["remoteAgentApi"],
    fileTransferApi: {
      list: async () => copy(transfers),
      chooseUpload: async (sessionId, remoteDir) => { const task: FileTransferTask = { id: `preview-transfer-${nextId++}`, sessionId, direction: "upload", name: "preview-upload.zip", remotePath: `${remoteDir}/preview-upload.zip`, status: "completed", transferredBytes: 4096, totalBytes: 4096, percent: 100, createdAt: Date.now(), updatedAt: Date.now() }; transfers = [...transfers, task]; emitTransfers(); return { canceled: false, tasks: [copy(task)] }; },
      uploadDroppedFiles: async (sessionId, remoteDir, files) => { const tasks = Array.from(files).map((file) => ({ id: `preview-transfer-${nextId++}`, sessionId, direction: "upload" as const, name: file.name, remotePath: `${remoteDir}/${file.name}`, status: "completed" as const, transferredBytes: file.size, totalBytes: file.size, percent: 100, createdAt: Date.now(), updatedAt: Date.now() })); transfers = [...transfers, ...tasks]; emitTransfers(); return { canceled: false, tasks: copy(tasks) }; },
      chooseDownload: async (sessionId, remotePath, fileName) => { const task: FileTransferTask = { id: `preview-transfer-${nextId++}`, sessionId, direction: "download", name: fileName || remotePath.split("/").pop() || "download", remotePath, status: "completed", transferredBytes: 8192, totalBytes: 8192, percent: 100, createdAt: Date.now(), updatedAt: Date.now() }; transfers = [...transfers, task]; emitTransfers(); return { canceled: false, task: copy(task) }; },
      chooseDownloadBatch: async (sessionId, entries) => { const tasks: FileTransferTask[] = entries.filter((entry) => entry.type !== "directory").map((entry) => ({ id: `preview-transfer-${nextId++}`, sessionId, direction: "download", name: entry.name, remotePath: entry.path, status: "completed", transferredBytes: entry.size, totalBytes: entry.size, percent: 100, createdAt: Date.now(), updatedAt: Date.now() })); transfers = [...transfers, ...tasks]; emitTransfers(); return { canceled: false, tasks: copy(tasks) }; },
      cancel: async (id) => { transfers = transfers.map((task) => task.id === id ? { ...task, status: "canceled", updatedAt: Date.now() } : task); emitTransfers(); return true; },
      retry: async (id) => { transfers = transfers.map((task) => task.id === id ? { ...task, status: "completed", percent: 100, transferredBytes: task.totalBytes, updatedAt: Date.now() } : task); emitTransfers(); return true; },
      resolveConflict: async () => true,
      clear: async (id) => { transfers = id ? transfers.filter((task) => task.id !== id) : []; emitTransfers(); return copy(transfers); },
      onChanged: transfersChanged.subscribe
    } satisfies Window["fileTransferApi"],
    gitApi,
    projectSearchApi: {
      searchWorkspaceEntries: async (_sessionId, query, rootPath = "C:\\workspace\\pannel-handle") => ({ root: rootPath, results: [{ path: `${rootPath}\\src`, relativePath: "src", name: "src", type: "directory" as const }, { path: `${rootPath}\\src\\App.tsx`, relativePath: "src/App.tsx", name: "App.tsx", type: "file" as const }].filter((item) => item.name.toLowerCase().includes(query.toLowerCase()) || !query) }),
      listDirectories: async (_sessionId, rootPath) => ({ workspaceRoot: "C:\\workspace\\pannel-handle", path: rootPath, directories: [{ name: "src", path: `${rootPath}\\src` }, { name: "electron", path: `${rootPath}\\electron` }] }),
      searchFiles: async (_sessionId, query, rootPath) => ({ root: rootPath, results: [{ path: `${rootPath}\\src\\App.tsx`, relativePath: "src/App.tsx", name: "App.tsx" }, { path: `${rootPath}\\package.json`, relativePath: "package.json", name: "package.json" }].filter((item) => item.name.toLowerCase().includes(query.toLowerCase())) }),
      searchText: async (_sessionId, query, _requestId, rootPath) => ({ root: rootPath, results: [{ path: `${rootPath}\\src\\App.tsx`, relativePath: "src/App.tsx", name: "App.tsx", lineNumber: 42, line: `const preview = "${query}";`, matchStart: 17, matchLength: query.length }], engine: "ripgrep" }),
      cancelTextSearch: async () => true
    } satisfies Window["projectSearchApi"],
    ideaBridgeApi: {
      getSnapshot: async () => copy(ideaSnapshot),
      start: async () => ({ accepted: true, count: 1 }),
      stop: async () => ({ accepted: true, count: 1 }),
      stopAll: async () => ({ accepted: true, count: 1 }),
      restart: async () => ({ accepted: true, count: 1 }),
      onChanged: ideaChanged.subscribe
    } satisfies Window["ideaBridgeApi"],
    windowApi: {
      minimize: () => undefined,
      toggleMaximize: () => { isMaximized = !isMaximized; maximizedChanged.emit(isMaximized); },
      close: () => closeRequested.emit(undefined),
      resolveClose: () => undefined,
      onCloseRequested: closeRequested.subscribe,
      isMaximized: async () => isMaximized,
      onMaximizedChanged: maximizedChanged.subscribe
    } satisfies Window["windowApi"]
  } satisfies Pick<Window,
    "sessionApi" | "environmentApi" | "terminalApi" | "screenshotApi" | "openRouterApi" | "naraRouterApi" | "miniMaxApi" |
    "agentConversationApi" | "codexAppServerApi" | "codexPluginApi" | "codeBuddyPluginApi" | "codeBuddyMcpApi" | "codeBuddyVersionApi" | "openCodeAuthApi" | "codexWorkspaceTrustApi" | "codexVersionApi" | "openCodeVersionApi" | "launchTemplateApi" | "mobileAccessApi" | "hookConfigApi" |
    "dingTalkApi" | "clipboardApi" | "externalLinkApi" | "remoteFileApi" | "remoteSystemApi" | "skillsApi" |
    "mcpApi" | "agentUsageApi" | "workBuddyCheckinApi" | "qoderCheckinApi" | "agentTokenStatsApi" | "postgresBackupApi" | "remoteAgentApi" |
    "fileTransferApi" | "gitApi" | "projectSearchApi" | "ideaBridgeApi" | "windowApi"
  >;

  const workItemChanges = createChannel<void>();
  let quickPrompts: import("../vite-env").WorkItemQuickPrompt[] = [];
  const previewWorkItem = { id: "preview-work-item", sourceRunId: "preview-run", taskId: "preview-task", ownerId: "preview-owner", templateId: "preview-local-template", taskName: "预览任务", unavailable: "", output: "检查项目并修复问题。", tools: [], needsFollowUp: true, status: "pending", version: 1, createdAt: now, updatedAt: now, owner: { id: "preview-owner", version: 1, name: "开发", responsibilities: "维护项目", directories: ["src"], createdAt: now, updatedAt: now }, template: { title: "本地开发", cwd: "C:\\workspace" } } as import("../vite-env").WorkItem;
  const workItemApi: import("../vite-env").WorkItemApi = {
    listQuickPrompts: async () => copy(quickPrompts),
    mutateQuickPrompt: async input => {
      const index = quickPrompts.findIndex(value => value.id === ("id" in input ? input.id : ""));
      if (input.operation !== "add" && (index < 0 || quickPrompts[index].version !== input.version)) throw new Error("常用提示词已修改或删除，请刷新后重试。");
      if (input.operation === "delete") quickPrompts.splice(index, 1);
      else if (input.operation === "add") quickPrompts.push({ id: `preview-prompt-${nextId++}`, version: 1, name: input.name, prompt: input.prompt, persistent: input.persistent === true });
      else quickPrompts[index] = { id: input.id, version: input.version + 1, name: input.name, prompt: input.prompt, persistent: input.persistent === true };
      workItemChanges.emit(); return copy(quickPrompts);
    },
    list: async () => ({ records: [{ ...copy(previewWorkItem), summary: previewWorkItem.output }], total: 1, templates: [], owners: [] }),
    get: async () => copy(previewWorkItem),
    preview: async input => ({ body: { prompt: input.prompt ?? previewWorkItem.output }, configuration: { cwd: previewWorkItem.template.cwd } }),
    execute: async () => { previewWorkItem.status = "running"; previewWorkItem.version++; workItemChanges.emit(); return copy(previewWorkItem); },
    markCompleted: async () => { previewWorkItem.status = "completed"; previewWorkItem.error = ""; previewWorkItem.version++; previewWorkItem.updatedAt = Date.now(); workItemChanges.emit(); return copy(previewWorkItem); },
    setFollowUp: async input => { previewWorkItem.needsFollowUp = input.needsFollowUp; workItemChanges.emit(); return copy(previewWorkItem); },
    listAttempts: async () => ({ records: [], total: 0 }),
    getAttempt: async () => { throw new Error("暂无执行记录。"); },
    void: async () => { previewWorkItem.status = "void"; return copy(previewWorkItem); },
    restore: async () => { previewWorkItem.status = "pending"; return copy(previewWorkItem); },
    resolveUncertain: async () => { previewWorkItem.status = "stopped"; return copy(previewWorkItem); },
    onChanged: callback => workItemChanges.subscribe(callback)
  };
  Object.assign(window, apis, { workItemApi, moduleOwnerApi: { listTemplates: async () => [], onChanged: () => () => {} } });
}
