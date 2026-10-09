import type {
  AppConfig,
  CodexExecutionPermission,
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
      verification: { modelId, status: "passed", checkedAt: now }
    }]
  };
}

export function installBrowserPreview() {
  let sessions: TerminalSession[] = [];
  let previewExecutionPermission: CodexExecutionPermission = "askApproval";
  let previewSkillEnabled = true;
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

  const apis = {
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
      onSnapshot: () => () => undefined
    } satisfies Window["agentConversationApi"],
    codexAppServerApi: {
      readConfiguration: async () => ({ config: { status: "ready" as const, data: { values: { model: "preview-model", features: {} }, layers: [] } }, requirements: { status: "ready" as const, data: null }, profiles: { status: "ready" as const, data: [] }, legacy: [], cwd: "预览工作区", runtime: { executionPermission: "askApproval" as const, permissionProfileId: null, mode: "default" } }),
      setPermissionProfile: async (_id: string, profileId: string) => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, permissionProfileId: profileId, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),

      setSubAgentView: async () => undefined,
      refreshSubAgents: async () => undefined,
      setupWindowsSandbox: async () => { throw new Error("浏览器预览不支持 Windows 沙箱初始化。"); },
      snapshot: async () => ({ threadId: "preview-thread", model: "preview-model", models: [{ id: "preview-model", displayName: "Preview", inputModalities: ["text", "image"], fastAvailable: false, defaultReasoningEffort: null, supportedReasoningEfforts: [] }], mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      listModelMetadata: async () => [],
      readAccount: async () => ({ status: "signedOut", requiresOpenaiAuth: true, account: null, login: null, rateLimits: null, usage: null, rateLimitsError: null, usageError: null, error: null }),
      startLogin: async () => ({ status: "signedOut", requiresOpenaiAuth: true, account: null, login: { type: "chatgpt", loginId: "preview", url: "https://example.com" }, rateLimits: null, usage: null, rateLimitsError: null, usageError: null, error: null }),
      cancelLogin: async () => ({ status: "signedOut", requiresOpenaiAuth: true, account: null, login: null, rateLimits: null, usage: null, rateLimitsError: null, usageError: null, error: null }),
      logout: async () => ({ status: "signedOut", requiresOpenaiAuth: true, account: null, login: null, rateLimits: null, usage: null, rateLimitsError: null, usageError: null, error: null }),
      refreshAccountUsage: async () => ({ status: "signedOut", requiresOpenaiAuth: true, account: null, login: null, rateLimits: null, usage: null, rateLimitsError: null, usageError: null, error: null }),
      listHistory: async () => ({ data: [], nextCursor: null }),
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
          resources: [], resourceTemplates: [], tools: [{ name: "read_file", description: "读取文件" }] }], errors: {} }),
      readPluginDetail: async () => { throw new Error("预览模式不支持插件详情。"); },
      readPluginSkill: async () => { throw new Error("预览模式不支持插件 Skill 读取。"); },
      readAppDetail: async () => { throw new Error("预览模式不支持 App 详情。"); },
      readMcpResource: async () => { throw new Error("预览模式不支持 MCP 资源读取。"); },
      loginMcpServer: async () => ({ authorizationUrl: "https://example.com/oauth" }),
      reloadMcpServers: async () => undefined,
      resume: async (_id, threadId) => ({ threadId, mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      newThread: async () => ({ threadId: `preview-thread-${nextId++}`, mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      renameThread: async () => undefined,
      pinThread: async (_id, _threadId, isPinned) => ({ isPinned }),
      deleteThread: async () => { throw new Error("预览模式不支持删除会话。"); },
      forkTurnToNewSession: async () => { throw new Error("预览模式不支持从此回合新建会话。"); },
      forkThread: async () => ({ threadId: `preview-thread-${nextId++}`, mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      archiveThread: async () => undefined,
      unarchiveThread: async () => undefined,
      compactThread: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, compactionStatus: "completed", error: null, pendingPlan: null, items: [], approvals: [] }),
      startReview: async () => { throw new Error("预览模式不支持代码审查。"); },
      listBackgroundTerminals: async () => [],
      askSideQuestion: async () => { throw new Error("预览模式不支持旁问。"); },
      cancelSideQuestion: async () => { throw new Error("预览模式不支持旁问。"); },
      listScheduledTasks: async () => { throw new Error("预览模式不支持定时任务。"); },
      createScheduledTask: async () => { throw new Error("预览模式不支持定时任务。"); },
      deleteScheduledTask: async () => { throw new Error("预览模式不支持定时任务。"); },
      listJobs: async () => [],
      jobDispatchContext: async () => ({}),
      listResumableJobs: async () => [],
      dispatchJob: async () => { throw new Error("预览模式不支持后台智能体。"); },
      resumeJob: async () => { throw new Error("预览模式不支持后台智能体。"); },
      jobTranscript: async () => ({ sessionId: null, updates: [] }),
      jobAction: async () => { throw new Error("预览模式不支持后台智能体。"); },
      watchJob: async () => undefined,
      unwatchJob: async () => undefined,
      onJobsEvent: () => () => undefined,
      onJobTranscript: () => () => undefined,
      terminateBackgroundTerminal: async () => { throw new Error("预览模式没有后台终端。"); },
      cleanBackgroundTerminals: async () => undefined,
      getGoal: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, goal: null, error: null, pendingPlan: null, items: [], approvals: [] }),
      setGoal: async (_id, changes) => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false,
        goal: { threadId: "preview-thread", objective: changes.objective || "预览目标", status: changes.status || "active", tokenBudget: changes.tokenBudget }, error: null, pendingPlan: null, items: [], approvals: [] }),
      clearGoal: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, goal: null, error: null, pendingPlan: null, items: [], approvals: [] }),
      refreshGoal: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, goal: null, error: null, pendingPlan: null, items: [], approvals: [] }),
      setMode: async (_id, mode) => ({ threadId: "preview-thread", mode, executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      setNativeMode: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      setModel: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      listMainAgents: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      setMainAgent: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      setContextWindow: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      sendTeamMessage: async () => undefined,
      setEffort: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      setFastMode: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      setMultitask: async () => ({ threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission, busy: false, error: null, pendingPlan: null, items: [], approvals: [] }),
      setExecutionPermission: async (_id, permission) => { previewExecutionPermission = permission; return {
        threadId: "preview-thread", mode: "default", executionPermission: previewExecutionPermission,
        busy: false, error: null, pendingPlan: null, items: [], approvals: [] }; },
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
    "environmentApi" | "terminalApi" | "screenshotApi" | "openRouterApi" | "naraRouterApi" | "miniMaxApi" |
    "agentConversationApi" | "codexAppServerApi" | "codexVersionApi" | "openCodeVersionApi" | "launchTemplateApi" | "mobileAccessApi" | "hookConfigApi" |
    "dingTalkApi" | "clipboardApi" | "externalLinkApi" | "remoteFileApi" | "remoteSystemApi" | "skillsApi" |
    "mcpApi" | "agentUsageApi" | "workBuddyCheckinApi" | "qoderCheckinApi" | "agentTokenStatsApi" | "postgresBackupApi" | "remoteAgentApi" |
    "fileTransferApi" | "gitApi" | "projectSearchApi" | "ideaBridgeApi" | "windowApi"
  >;

  Object.assign(window, apis);
}
