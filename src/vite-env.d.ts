/// <reference types="vite/client" />

export type QuickCommand = {
  id: string;
  command: string;
  mode?: 'auto-enter' | 'write' | 'one-time';
};

export type SshConfig = {
  host: string;
  username?: string;
  port?: number;
  identityFile?: string;
  remoteCommand?: string;
  extraArgs?: string[];
  remark?: string;
  hasSecret?: boolean;
  secret?: string;
  clearSecret?: boolean;
};

export type TerminalSession = {
  id: string;
  templateId?: string;
  title: string;
  shell: string;
  cwd: string;
  createdAt: number;
  initialCommand?: string;
  agentProvider?: AgentProvider;
  type: 'windows' | 'wsl' | 'ssh';
  wslDistro?: string;
  sshConfig?: SshConfig;
  quickCommands?: QuickCommand[];
  tags?: string[];
  gitCwd?: string;
  gitCwdHistory?: string[];
  listenerAgents?: ListenerAgent[];
};

export type ListenerAgentPermission = "read-only" | "write";
export type ListenerTriggerEvent = "add" | "change" | "unlink";

export type ListenerAgentTrigger = {
  id: string;
  name: string;
  type: "file" | "interval" | "cron" | "manual";
  enabled: boolean;
  prompt: string;
  include?: string[];
  exclude?: string[];
  events?: ListenerTriggerEvent[];
  debounceMs?: number;
  intervalMinutes?: number;
  cron?: string;
};

export type ListenerAgent = {
  id: string;
  name: string;
  provider: AgentProvider;
  cliTemplateId?: string;
  enabled: boolean;
  permission: ListenerAgentPermission;
  timeoutMinutes: number;
  ignoreOwnChanges: boolean;
  triggers: ListenerAgentTrigger[];
  running?: boolean;
  pending?: boolean;
};

export type ListenerAgentState = {
  templateId: string;
  active: boolean;
  hostSessionId?: string;
  agents: ListenerAgent[];
};

export type ListenerAgentRun = {
  id: string;
  triggerId: string;
  triggerName: string;
  triggerType: ListenerAgentTrigger["type"];
  changedFiles: string[];
  status: "completed" | "failed" | "canceled";
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated?: boolean;
};

export type ThemeId = "dark-slate" | "dark-blue" | "dark-green" | "light";
export type Locale = "zh-CN" | "en-US";

export type AppConfig = {
  autoRestore: boolean;
  debugMode: boolean;
  lastActiveSessionIds: string[];
  themeId: ThemeId;
  locale: Locale;
  rightToolsWidth: number;
};

export type DingTalkConfig = {
  enabled: boolean;
  hasWebhook: boolean;
  hasSecret: boolean;
};

export type DingTalkConfigInput = {
  enabled?: boolean;
  webhook?: string;
  secret?: string;
};

export type DingTalkTestResult =
  | { ok: true }
  | { ok: false; error: string };

export type CompletionConfig = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  thinkingEnabled: boolean;
  thinkingLevel: "high" | "max";
};

export type CompletionConfigInput = {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  thinkingEnabled?: boolean;
  thinkingLevel?: "high" | "max";
};

export type CompletionRequest = {
  sessionId: string;
  draft: string;
  cursor: number;
  localOnly?: boolean;
};

export type CompletionMode = "agent" | "shell";
export type CompletionSource = "model" | "history";

export type CompletionResult = {
  candidateId: string;
  completion: string;
  mode: CompletionMode;
  source: CompletionSource;
  confidence?: number;
};

export type CompletionFeedbackInput = {
  candidateId: string;
  event: "shown" | "accepted" | "dismissed" | "submitted_after_accept";
  editDistance?: number;
  finalLength?: number;
};

export type CompletionMetricCounters = {
  shown: number;
  accepted: number;
  dismissed: number;
  submittedAfterAccept: number;
  zeroEditSubmissions: number;
  editDistanceTotal: number;
  finalLengthTotal: number;
  errors: number;
  latencyBuckets: { lt250: number; lt1000: number; lt3000: number; gte3000: number };
};

export type CompletionMetricGroups = Record<CompletionMode, Record<CompletionSource, CompletionMetricCounters>>;

export type CompletionMetrics = {
  version: number;
  totals: CompletionMetricGroups;
  days: Record<string, CompletionMetricGroups>;
};

export type CompletionDebugRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

export type CompletionDebugPayload = {
  requestId: string;
  phase: "request" | "response" | "error";
  timestamp: number;
  sessionId: string;
  request?: CompletionDebugRequest;
  durationMs?: number;
  status?: "success" | "error";
  httpStatus?: number;
  responseBody?: string;
  completion?: string;
  error?: string;
};

export type CompletionTestResult =
  | { ok: true }
  | { ok: false; error: string };

export type SessionLibraryFileResult =
  | { canceled: true }
  | { canceled: false; ok: true; filePath: string; exportedCount: number }
  | { canceled: false; ok: false; error: string };

export type SessionLibraryImportResult =
  | { canceled: true }
  | { canceled: false; ok: true; filePath: string; importedCount: number; sessions: TerminalSession[] }
  | { canceled: false; ok: false; error: string };

export type RemoteFileEntry = {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modifiedAt: number;
  rights?: {
    user?: string;
    group?: string;
    other?: string;
  };
};

export type RemoteTextPreview =
  | { kind: "text"; size: number; content: string; version: string }
  | { kind: "binary"; size: number }
  | { kind: "too_large"; size: number; limit: number };

export type RemoteMediaPreview =
  | { kind: "image"; size: number; mime: string; previewId: string; url: string }
  | { kind: "video"; size: number; mime: string; previewId: string; url: string };

export type RemoteFilePreview = RemoteTextPreview | RemoteMediaPreview;

export type RemoteTextWriteResult =
  | { status: "saved"; size: number; version: string }
  | { status: "conflict" };

export type RemoteFileDialogResult =
  | { canceled: true }
  | { canceled: false; remotePath?: string; localPath?: string };

export type RemoteFileBatchUploadResult =
  | { canceled: true }
  | { canceled: false; uploaded: { remotePath: string }[] };

export type RemoteSystemMetrics = {
  sampledAt: number;
  network: {
    receivedBytesPerSecond: number | null;
    transmittedBytesPerSecond: number | null;
  };
  memory: {
    usedBytes: number;
    totalBytes: number;
  };
  disk?: {
    filesystem: string;
    type: string;
    mountPoint: string;
    usedBytes: number;
    totalBytes: number;
    availableBytes: number;
    usedPercent: number;
  };
};

export type GitStatusEntry = {
  status: string;
  label: string;
  path: string;
  oldPath?: string;
};

export type GitStatusResult = {
  cwd: string;
  clean: boolean;
  files: GitStatusEntry[];
};

export type GitDiffRowType = "context" | "add" | "delete" | "modify";

export type GitDiffRow = {
  type: GitDiffRowType;
  oldLineNumber?: number;
  newLineNumber?: number;
  oldText?: string;
  newText?: string;
};

export type GitDiffResult = {
  cwd: string;
  path: string;
  oldPath?: string;
  status: string;
  kind: "text" | "binary";
  rows: GitDiffRow[];
};

export type GitBranchEntry = {
  name: string;
  kind: "local" | "remote";
  current: boolean;
  commit: string;
  relativeTime: string;
};

export type GitBranchListResult = {
  cwd: string;
  branches: GitBranchEntry[];
};

export type GitStashEntry = {
  ref: string;
  commit: string;
  relativeTime: string;
  message: string;
};

export type GitStashListResult = {
  cwd: string;
  stashes: GitStashEntry[];
};

export type GitOperationResult = {
  ok: boolean;
  cwd: string;
  message?: string;
  status?: GitStatusResult;
  branches?: GitBranchListResult;
};

export type GitDirectoryChangeResult = {
  cwd: string;
  history: string[];
  status: GitStatusResult;
  branches: GitBranchListResult;
  stashes: GitStashListResult;
};

export type ProjectFileSearchResult = {
  path: string;
  relativePath: string;
  name: string;
};

export type WorkspaceEntrySearchResult = ProjectFileSearchResult & {
  type: "file" | "directory";
};

export type WorkspaceEntrySearchResponse = {
  root: string;
  results: WorkspaceEntrySearchResult[];
};

export type ProjectTextSearchResult = ProjectFileSearchResult & {
  lineNumber: number;
  line: string;
  matchStart: number;
  matchLength: number;
};

export type ProjectFileSearchResponse = {
  root: string;
  results: ProjectFileSearchResult[];
};

export type ProjectTextSearchResponse = {
  root: string;
  results: ProjectTextSearchResult[];
  engine: "ripgrep" | "fallback";
};

export type AgentProvider = "claude" | "codex" | "opencode" | "qoder";
export type HookProvider = AgentProvider;

export type HookInstallTarget =
  | { type: "windows"; path: string }
  | { type: "wsl"; path: string; wslDistro: string }
  | { type: "ssh"; sessionId: string; path: string };

export type HookInstallStatus = "not_installed" | "installed" | "needs_repair";

export type HookProviderInspection = {
  status: HookInstallStatus;
  configPath?: string;
  scriptPath: string;
  managedHookCount: number;
  expectedHookCount: number;
};

export type HookInspectionResult = {
  ok: boolean;
  projectPath?: string;
  error?: string;
  providers: Partial<Record<HookProvider, HookProviderInspection>>;
};

export type AgentRunStatus = "running" | "waiting_for_permission" | "e_prompt" | "completed" | "failed" | "ended" | "exited";

export type AgentStatusPayload = {
  id: string;
  provider: AgentProvider;
  status: AgentRunStatus;
  eventName: string;
  timestamp: number;
  message?: string;
  toolName?: string;
  toolInput?: unknown;
  lastAssistantMessage?: string;
  resolution?: "none" | "provide_input";
};

export type AgentHookDebugPayload = {
  provider: AgentProvider;
  eventName: string;
  timestamp: number;
  matchedSessionId?: string;
  handled: boolean;
  payload: unknown;
};

export type TerminalApi = {
  listSessions: () => Promise<TerminalSession[]>;
  createSession: (options?: { title?: string; shell?: string; cwd?: string; cols?: number; rows?: number; initialCommand?: string; agentProvider?: AgentProvider; type?: 'windows' | 'wsl' | 'ssh'; wslDistro?: string; sshConfig?: SshConfig; quickCommands?: QuickCommand[]; tags?: string[] }) => Promise<TerminalSession>;
  updateSession: (id: string, updates: { title?: string; cwd?: string; initialCommand?: string; agentProvider?: AgentProvider | null; sshConfig?: SshConfig; quickCommands?: QuickCommand[]; tags?: string[] }) => Promise<TerminalSession[]>;
  closeSession: (id: string) => Promise<TerminalSession[]>;
  getHistory: (id: string) => Promise<string>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  onData: (callback: (payload: { id: string; data: string }) => void) => () => void;
  onExit: (callback: (payload: { id: string; exitCode: number }) => void) => () => void;
  onAgentStatus: (callback: (payload: AgentStatusPayload) => void) => () => void;
  onAgentHookDebug: (callback: (payload: AgentHookDebugPayload) => void) => () => void;
  onSessionsChanged: (callback: (sessions: TerminalSession[]) => void) => () => void;
  onSessionSelectRequested: (callback: (payload: { id: string }) => void) => () => void;
  listWslDistros: () => Promise<string[]>;
  loadSavedSessions: () => Promise<TerminalSession[]>;
  exportSavedSessions: () => Promise<SessionLibraryFileResult>;
  importSavedSessions: () => Promise<SessionLibraryImportResult>;
  launchSessions: (sessions: TerminalSession[]) => Promise<TerminalSession[]>;
  deleteSavedSession: (id: string) => Promise<TerminalSession[]>;
  duplicateSession: (id: string) => Promise<TerminalSession>;
  reorderSavedSessions: (orderedIds: string[]) => Promise<TerminalSession[]>;
  reorderRunningSessions: (orderedIds: string[]) => Promise<TerminalSession[]>;
  getConfig: () => Promise<AppConfig>;
  setConfig: (partial: Partial<AppConfig>) => Promise<AppConfig>;
};

export type WindowApi = {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizedChanged: (callback: (isMaximized: boolean) => void) => () => void;
};

export type ClipboardApi = {
  writeText: (text: string) => Promise<boolean>;
  readText: () => Promise<string>;
  pasteImageToSession: (sessionId: string) => Promise<
    | { status: "no_image" }
    | { status: "saved"; path: string; size: number }
  >;
};

export type RemoteFileApi = {
  getHome: (sessionId: string) => Promise<string>;
  list: (sessionId: string, remotePath: string) => Promise<RemoteFileEntry[]>;
  readText: (sessionId: string, remotePath: string) => Promise<RemoteTextPreview>;
  previewFile: (sessionId: string, remotePath: string) => Promise<RemoteFilePreview>;
  releasePreview: (previewId: string) => Promise<boolean>;
  writeText: (sessionId: string, remotePath: string, content: string, expectedVersion: string) => Promise<RemoteTextWriteResult>;
  uploadFile: (sessionId: string, remoteDir: string) => Promise<RemoteFileDialogResult>;
  uploadDroppedFiles: (sessionId: string, remoteDir: string, files: FileList | File[]) => Promise<RemoteFileBatchUploadResult>;
  downloadFile: (sessionId: string, remotePath: string, fileName?: string) => Promise<RemoteFileDialogResult>;
  startDownloadDrag: (sessionId: string, remotePath: string, fileName?: string) => Promise<RemoteFileDialogResult>;
  openInExplorer: (sessionId: string, remotePath: string) => Promise<void>;
  deleteEntry: (sessionId: string, remotePath: string) => Promise<void>;
};

export type RemoteSystemApi = {
  getMetrics: (sessionId: string) => Promise<RemoteSystemMetrics>;
};

export type GitApi = {
  changeDirectory: (sessionId: string, cwd: string) => Promise<GitDirectoryChangeResult>;
  getStatus: (sessionId: string) => Promise<GitStatusResult>;
  getDiff: (sessionId: string, file: GitStatusEntry) => Promise<GitDiffResult>;
  getBranches: (sessionId: string) => Promise<GitBranchListResult>;
  checkoutBranch: (sessionId: string, branch: Pick<GitBranchEntry, "name" | "kind">) => Promise<GitOperationResult>;
  getStashes: (sessionId: string) => Promise<GitStashListResult>;
  stashChanges: (sessionId: string) => Promise<GitOperationResult>;
  applyStash: (sessionId: string, ref: string) => Promise<GitOperationResult>;
  popStash: (sessionId: string, ref: string) => Promise<GitOperationResult>;
  revertFile: (sessionId: string, file: GitStatusEntry) => Promise<GitOperationResult>;
};

export type ProjectSearchApi = {
  searchWorkspaceEntries: (sessionId: string, query: string) => Promise<WorkspaceEntrySearchResponse>;
  listDirectories: (sessionId: string, rootPath: string) => Promise<{
    workspaceRoot: string;
    path: string;
    directories: Array<{ name: string; path: string }>;
  }>;
  searchFiles: (sessionId: string, query: string, rootPath: string) => Promise<ProjectFileSearchResponse>;
  searchText: (sessionId: string, query: string, requestId: string, rootPath: string) => Promise<ProjectTextSearchResponse>;
  cancelTextSearch: (sessionId: string, requestId: string) => Promise<boolean>;
};

export type HookConfigApi = {
  selectProjectDirectory: (defaultPath?: string) => Promise<{ canceled: true } | { canceled: false; path: string }>;
  inspect: (target: HookInstallTarget, providers: HookProvider[]) => Promise<HookInspectionResult>;
  install: (target: HookInstallTarget, providers: HookProvider[]) => Promise<HookInspectionResult>;
};

export type ListenerAgentApi = {
  getState: (templateId: string) => Promise<ListenerAgentState>;
  save: (templateId: string, agent: ListenerAgent) => Promise<ListenerAgentState>;
  delete: (templateId: string, agentId: string) => Promise<ListenerAgentState>;
  run: (templateId: string, agentId: string, triggerId: string) => Promise<ListenerAgentState>;
  cancel: (templateId: string, agentId: string) => Promise<ListenerAgentState>;
  history: (templateId: string, agentId: string) => Promise<ListenerAgentRun[]>;
  clearHistory: (templateId: string, agentId: string) => Promise<ListenerAgentRun[]>;
  onChanged: (callback: (state: ListenerAgentState) => void) => () => void;
  onOutput: (callback: (payload: { templateId: string; agentId: string; runId: string; stream: "stdout" | "stderr"; chunk: string }) => void) => () => void;
};

export type DingTalkApi = {
  getConfig: () => Promise<DingTalkConfig>;
  setConfig: (input: DingTalkConfigInput) => Promise<DingTalkConfig>;
  clearCredentials: () => Promise<DingTalkConfig>;
  test: () => Promise<DingTalkTestResult>;
};

export type CompletionApi = {
  getConfig: () => Promise<CompletionConfig>;
  setConfig: (input: CompletionConfigInput) => Promise<CompletionConfig>;
  clearCredentials: () => Promise<CompletionConfig>;
  test: () => Promise<CompletionTestResult>;
  complete: (input: CompletionRequest) => Promise<CompletionResult>;
  recordSubmission: (input: { sessionId: string; value: string }) => Promise<boolean>;
  recordFeedback: (input: CompletionFeedbackInput) => Promise<boolean>;
  getMetrics: () => Promise<CompletionMetrics>;
  clearMetrics: () => Promise<CompletionMetrics>;
  onDebugEvent: (callback: (payload: CompletionDebugPayload) => void) => () => void;
};

declare global {
  interface Window {
    terminalApi: TerminalApi;
    clipboardApi: ClipboardApi;
    remoteFileApi: RemoteFileApi;
    remoteSystemApi: RemoteSystemApi;
    gitApi: GitApi;
    projectSearchApi: ProjectSearchApi;
    hookConfigApi: HookConfigApi;
    listenerAgentApi: ListenerAgentApi;
    dingTalkApi: DingTalkApi;
    completionApi: CompletionApi;
    windowApi: WindowApi;
  }
}
