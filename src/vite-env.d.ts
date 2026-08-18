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
  fileRoot?: string;
  fileSort?: FileSort;
  createdAt: number;
  initialCommand?: string;
  agentProvider?: AgentProvider;
  agentLocation?: AgentLocation;
  type: 'windows' | 'wsl' | 'ssh';
  wslDistro?: string;
  sshConfig?: SshConfig;
  quickCommands?: QuickCommand[];
  tags?: string[];
  gitCwd?: string;
  gitCwdHistory?: string[];
  readonly recentLaunchCount?: number;
  readonly lastLaunchedAt?: number;
};

export type LaunchTemplate = {
  id: string;
  name: string;
  sessionTemplateIds: string[];
  createdAt: number;
  updatedAt: number;
};

export type LaunchTemplateSaveInput = {
  name: string;
  sessionTemplateIds: string[];
};

export type LaunchTemplateResult = {
  launchedSessionIds: string[];
  failures: Array<{
    templateId: string;
    title?: string;
    error: string;
  }>;
};

export type LaunchTemplateApi = {
  list: () => Promise<LaunchTemplate[]>;
  create: (input: LaunchTemplateSaveInput) => Promise<LaunchTemplate>;
  update: (id: string, input: LaunchTemplateSaveInput) => Promise<LaunchTemplate>;
  delete: (id: string) => Promise<LaunchTemplate[]>;
  launch: (id: string) => Promise<LaunchTemplateResult>;
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
  listenerAgentHistoryMaxEntries: number;
  listenerAgentOutputMaxBytes: number;
};

export type MobileAccessInterface = { name: string; address: string };
export type MobileAccessDevice = { id: string; name: string; createdAt: number; lastSeenAt: number };
export type MobileAccessAuditEntry = {
  id: string;
  at: number;
  type: string;
  deviceId?: string;
  deviceName?: string;
  reason?: string;
  remoteAddress?: string;
};
export type MobileAccessState = {
  config: { enabled: boolean; interfaceName: string; port: number };
  interfaces: MobileAccessInterface[];
  running: boolean;
  hostname: string;
  address: string;
  canonicalUrl: string;
  fallbackUrl: string;
  lastError: string;
  devices: MobileAccessDevice[];
  activeDevice: { id: string; name: string; connected: boolean; graceUntil?: number } | null;
};
export type MobilePairingInfo = { url: string; fallbackUrl: string; expiresAt: number; qrDataUrl: string };

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

export type FileSort = {
  key: "name" | "modifiedAt" | "size";
  direction: "asc" | "desc";
};

export type FileConflictPolicy = "overwrite" | "skip" | "rename" | "cancel";

export type RemoteFileMutationResult = {
  status: "completed" | "conflict" | "skipped";
  path: string;
  name: string;
};

export type RemoteTextPreview =
  | { kind: "text"; size: number; content: string; version: string; encoding: "utf-8"; bom: boolean; eol: "lf" | "crlf" | "cr" }
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
  | { canceled: false; remotePath?: string; localPath?: string; transferId?: string };

export type RemoteFileDownloadProgress = {
  transferId: string;
  sessionId: string;
  remotePath: string;
  fileName?: string;
  transferredBytes?: number;
  totalBytes?: number;
  percent?: number | null;
  status: "running" | "completed" | "canceled" | "failed";
  error?: string;
};

export type RemoteFileBatchUploadResult =
  | { canceled: true }
  | { canceled: false; uploaded: { remotePath: string }[] };

export type FileTransferTask = {
  id: string;
  sessionId: string;
  direction: "upload" | "download";
  name: string;
  localPath?: string;
  remotePath?: string;
  status: "queued" | "running" | "conflict" | "completed" | "canceled" | "failed";
  transferredBytes: number;
  totalBytes: number;
  percent: number | null;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

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
  indexStatus: string;
  worktreeStatus: string;
  conflicted: boolean;
  path: string;
  oldPath?: string;
};

export type GitBranchState = {
  name: string;
  oid: string;
  detached: boolean;
  unborn: boolean;
  upstream?: {
    name: string;
    remote: string;
    branch: string;
  };
  ahead: number;
  behind: number;
};

export type GitStatusResult = {
  cwd: string;
  clean: boolean;
  files: GitStatusEntry[];
  branch: GitBranchState;
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
  scope: GitDiffScope;
  kind: "text" | "binary";
  rows: GitDiffRow[];
  truncated: boolean;
  capturedBytes: number;
};

export type GitDiffScope = "working" | "staged" | "commit" | "stash" | "combined";

export type GitDiffRequest = {
  scope: GitDiffScope;
  path?: string;
  oldPath?: string;
  status?: string;
  indexStatus?: string;
  worktreeStatus?: string;
  revision?: string;
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
  error?: string;
};

export type GitRemoteListResult = {
  cwd: string;
  remotes: string[];
  error?: string;
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
  error?: string;
};

export type GitRepositoryOperationState = "merge" | "rebase" | "cherry-pick" | "revert";

export type GitRepositorySnapshot = {
  cwd: string;
  status: GitStatusResult;
  branches: GitBranchListResult;
  remotes: GitRemoteListResult;
  stashes: GitStashListResult;
  operationState: GitRepositoryOperationState | null;
  operationStateError?: string;
};

export type GitHistoryEntry = {
  oid: string;
  shortOid: string;
  authorName: string;
  authorEmail: string;
  authoredAt: number;
  subject: string;
  decorations: string[];
};

export type GitHistoryResult = {
  cwd: string;
  commits: GitHistoryEntry[];
  hasMore: boolean;
  nextSkip: number;
};

export type GitOperationResult = {
  ok: boolean;
  operationId?: string;
  cwd?: string;
  message?: string;
  stdout?: string;
  stderr?: string;
  canceled?: boolean;
  truncated?: boolean;
};

export type GitDirectoryChangeResult = {
  cwd: string;
  history: string[];
  snapshot: GitRepositorySnapshot;
  status: GitStatusResult;
  branches: GitBranchListResult;
  stashes: GitStashListResult;
};

export type GitRepositoryEntry = {
  cwd: string;
  name: string;
  relativePath: string;
};

export type GitRepositoryDiscoveryResult = {
  root: string;
  repositories: GitRepositoryEntry[];
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

export type ProjectSearchOptions = {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  includeIgnored?: boolean;
};

export type AgentProvider = "claude" | "codex" | "codebuddy" | "opencode" | "qoder";
export type AgentLocation = "local" | "remote";
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

export type AgentRunStatus = "running" | "waiting_for_permission" | "e_prompt" | "completed" | "failed" | "ended" | "exited" | "cleared";

export type AgentStatusPayload = {
  id: string;
  provider: AgentProvider;
  status: AgentRunStatus;
  eventName: string;
  timestamp: number;
  message?: string;
  toolName?: string;
  toolInput?: unknown;
  activitySummary?: string;
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

export type AgentUsageLimit = {
  id: string;
  name: string;
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
  category?: "base" | "extra" | "bonus" | "other";
  totalAmount?: number;
  usedAmount?: number;
  remainingAmount?: number;
  unit?: "Credits";
  expiresAt?: number;
};

export type AgentUsageCreditSummary = {
  kind: "credits";
  total: number;
  used: number;
  remaining: number;
  usedPercent: number;
  remainingPercent: number;
  unit: "Credits";
};

export type AgentUsageSnapshot = {
  provider: "codex" | "codebuddy";
  fetchedAt: number;
  primaryLimitId: string;
  summary?: AgentUsageCreditSummary;
  limits: AgentUsageLimit[];
};

export type AgentUsageApi = {
  getUsage: (sessionId: string, options?: { force?: boolean }) => Promise<AgentUsageSnapshot>;
  cancel: (sessionId: string) => void;
};

export type WorkBuddyCheckinStatus = {
  active: boolean;
  todayCheckedIn: boolean;
  streakDays: number;
  dailyCredit: number;
  todayCredit: number;
  totalCredits: number;
  weekProgress: boolean[];
};

export type WorkBuddyCheckinResult = {
  alreadyCheckedIn: boolean;
  status: WorkBuddyCheckinStatus;
};

export type WorkBuddyCheckinApi = {
  getStatus: () => Promise<WorkBuddyCheckinStatus>;
  claim: () => Promise<WorkBuddyCheckinResult>;
};

export type AgentTokenTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type AgentTokenSessionRecord = {
  id: string;
  provider: "codex" | "claude" | "codebuddy";
  agentSessionId: string;
  panelSessionId: string;
  templateId?: string;
  title: string;
  cwd: string;
  location: "windows" | "wsl" | "ssh";
  models: string[];
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  status: "active" | "ended";
  tokens: AgentTokenTotals;
};

export type AgentTokenDashboard = {
  generatedAt: number;
  range: "7d" | "30d" | "all";
  provider: "all" | "codex" | "claude" | "codebuddy";
  summary: { sessionCount: number; averageTokens: number; tokens: AgentTokenTotals };
  dailyTrend: Array<{ date: string; tokens: AgentTokenTotals }>;
  providerBreakdown: Array<{ provider: "codex" | "claude" | "codebuddy"; sessionCount: number; tokens: AgentTokenTotals }>;
  sessions: AgentTokenSessionRecord[];
  totalCount: number;
  offset: number;
  limit: number;
};

export type AgentTokenLiveSnapshot = {
  panelSessionId: string;
  provider: "codex" | "codebuddy";
  state: "waiting" | "generating" | "completed" | "unavailable";
  tokens: AgentTokenTotals;
  turnOutputTokens: number;
  outputTokensPerSecond: number;
  models: string[];
  updatedAt: number;
};

export type AgentTokenStatsApi = {
  getDashboard: (options?: { range?: "7d" | "30d" | "all"; provider?: "all" | "codex" | "claude" | "codebuddy"; offset?: number; limit?: number }) => Promise<AgentTokenDashboard>;
  getLive: (sessionId: string) => Promise<AgentTokenLiveSnapshot | null>;
  clear: () => Promise<boolean>;
  onChanged: (callback: (payload: { timestamp: number }) => void) => () => void;
  onLiveChanged: (callback: (payload: AgentTokenLiveSnapshot) => void) => () => void;
};

export type RemoteAgentAuditEvent = {
  sessionId: string;
  timestamp: number;
  operationId: string;
  kind: "operation" | "output" | "approval";
  tool: string;
  status: string;
  summary?: string;
  stream?: "stdout" | "stderr";
  output?: string;
  exitCode?: number;
  signal?: string;
  error?: string;
};

export type RemoteAgentApi = {
  listAudit: (sessionId: string) => Promise<RemoteAgentAuditEvent[]>;
  onAudit: (callback: (payload: RemoteAgentAuditEvent) => void) => () => void;
};

export type TerminalApi = {
  listSessions: () => Promise<TerminalSession[]>;
  createSession: (options?: { title?: string; shell?: string; cwd?: string; cols?: number; rows?: number; initialCommand?: string; agentProvider?: AgentProvider; agentLocation?: AgentLocation; type?: 'windows' | 'wsl' | 'ssh'; wslDistro?: string; sshConfig?: SshConfig; quickCommands?: QuickCommand[]; tags?: string[] }) => Promise<TerminalSession>;
  updateSession: (id: string, updates: { title?: string; cwd?: string; fileRoot?: string; fileSort?: FileSort; initialCommand?: string; agentProvider?: AgentProvider | null; agentLocation?: AgentLocation | null; sshConfig?: SshConfig; quickCommands?: QuickCommand[]; tags?: string[] }) => Promise<TerminalSession[]>;
  closeSession: (id: string) => Promise<TerminalSession[]>;
  getHistory: (id: string) => Promise<string>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  claimSize: (id: string, cols: number, rows: number) => void;
  onData: (callback: (payload: { id: string; data: string }) => void) => () => void;
  onExit: (callback: (payload: { id: string; exitCode: number }) => void) => () => void;
  onSizeOwner: (callback: (payload: { sessionId: string; owner: string; cols: number; rows: number }) => void) => () => void;
  onAgentStatus: (callback: (payload: AgentStatusPayload) => void) => () => void;
  onAgentHookDebug: (callback: (payload: AgentHookDebugPayload) => void) => () => void;
  onSessionsChanged: (callback: (sessions: TerminalSession[]) => void) => () => void;
  onSessionSelectRequested: (callback: (payload: { id: string }) => void) => () => void;
  listWslDistros: () => Promise<string[]>;
  loadSavedSessions: () => Promise<TerminalSession[]>;
  exportSavedSessions: () => Promise<SessionLibraryFileResult>;
  importSavedSessions: () => Promise<SessionLibraryImportResult>;
  launchSessions: (sessions: TerminalSession[], launchMode: "manual" | "restore") => Promise<TerminalSession[]>;
  deleteSavedSession: (id: string) => Promise<TerminalSession[]>;
  duplicateSession: (id: string) => Promise<TerminalSession>;
  reorderRunningSessions: (orderedIds: string[]) => Promise<TerminalSession[]>;
  getConfig: () => Promise<AppConfig>;
  setConfig: (partial: Partial<AppConfig>) => Promise<AppConfig>;
};

export type WindowApi = {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  resolveClose: (confirmed: boolean) => void;
  onCloseRequested: (callback: () => void) => () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizedChanged: (callback: (isMaximized: boolean) => void) => () => void;
};

export type MobileAccessApi = {
  getState: () => Promise<MobileAccessState>;
  updateConfig: (partial: Partial<MobileAccessState["config"]>) => Promise<MobileAccessState>;
  createPairing: () => Promise<MobilePairingInfo>;
  listAudit: () => Promise<MobileAccessAuditEntry[]>;
  revokeDevice: (deviceId: string) => Promise<MobileAccessState>;
  disconnectDevice: () => Promise<MobileAccessState>;
  onStateChanged: (callback: (state: MobileAccessState) => void) => () => void;
};

export type ClipboardApi = {
  writeText: (text: string) => Promise<boolean>;
  readText: () => Promise<string>;
  pasteImageToSession: (sessionId: string) => Promise<
    | { status: "no_image" }
    | { status: "saved"; path: string; size: number }
  >;
};

export type ExternalLinkApi = {
  open: (url: string) => Promise<void>;
};

export type RemoteFileApi = {
  getHome: (sessionId: string) => Promise<string>;
  list: (sessionId: string, remotePath: string) => Promise<RemoteFileEntry[]>;
  readText: (sessionId: string, remotePath: string) => Promise<RemoteTextPreview>;
  previewFile: (sessionId: string, remotePath: string) => Promise<RemoteFilePreview>;
  releasePreview: (previewId: string) => Promise<boolean>;
  writeText: (sessionId: string, remotePath: string, content: string, expectedVersion: string, options?: { force?: boolean; format?: { bom?: boolean; eol?: "lf" | "crlf" | "cr" } }) => Promise<RemoteTextWriteResult>;
  createEntry: (sessionId: string, parentPath: string, name: string, kind: "file" | "directory", conflictPolicy?: FileConflictPolicy) => Promise<RemoteFileMutationResult>;
  moveEntry: (sessionId: string, sourcePath: string, targetDirectory: string, name?: string, conflictPolicy?: FileConflictPolicy) => Promise<RemoteFileMutationResult>;
  chooseRoot: (sessionId: string, currentRoot: string) => Promise<{ canceled: true } | { canceled: false; path: string }>;
  uploadFile: (sessionId: string, remoteDir: string) => Promise<RemoteFileDialogResult>;
  uploadDroppedFiles: (sessionId: string, remoteDir: string, files: FileList | File[] | string[]) => Promise<RemoteFileBatchUploadResult>;
  downloadFile: (transferId: string, sessionId: string, remotePath: string, fileName?: string) => Promise<RemoteFileDialogResult>;
  startDownloadDrag: (transferId: string, sessionId: string, remotePath: string, fileName?: string) => Promise<RemoteFileDialogResult>;
  cancelDownload: (transferId: string) => Promise<boolean>;
  onDownloadProgress: (callback: (progress: RemoteFileDownloadProgress) => void) => () => void;
  openInExplorer: (sessionId: string, remotePath: string) => Promise<void>;
  deleteEntry: (sessionId: string, remotePath: string, options?: { permanent?: boolean }) => Promise<{ mode: "trash" | "permanent" }>;
  watchDirectories: (sessionId: string, directories: string[]) => Promise<boolean>;
  unwatchDirectories: (sessionId: string) => Promise<void>;
  onChanged: (callback: (payload: { sessionId: string; paths: string[] }) => void) => () => void;
  onWatchError: (callback: (payload: { sessionId: string; error: string }) => void) => () => void;
};

export type RemoteSystemApi = {
  getMetrics: (sessionId: string) => Promise<RemoteSystemMetrics>;
};

export type FileTransferApi = {
  list: () => Promise<FileTransferTask[]>;
  chooseUpload: (sessionId: string, remoteDir: string) => Promise<{ canceled: true } | { canceled: false; tasks: FileTransferTask[] }>;
  uploadDroppedFiles: (sessionId: string, remoteDir: string, files: FileList | File[]) => Promise<{ canceled: false; tasks: FileTransferTask[] }>;
  chooseDownload: (sessionId: string, remotePath: string, fileName?: string) => Promise<{ canceled: true } | { canceled: false; task: FileTransferTask }>;
  cancel: (id: string) => Promise<boolean>;
  retry: (id: string) => Promise<boolean>;
  resolveConflict: (id: string, policy: "overwrite" | "skip" | "rename") => Promise<boolean>;
  clear: (id?: string) => Promise<FileTransferTask[]>;
  onChanged: (callback: (tasks: FileTransferTask[]) => void) => () => void;
};

export type GitApi = {
  changeDirectory: (sessionId: string, cwd: string) => Promise<GitDirectoryChangeResult>;
  getSnapshot: (sessionId: string) => Promise<GitRepositorySnapshot>;
  discoverRepository: (sessionId: string) => Promise<{ cwd: string }>;
  discoverRepositories: (sessionId: string) => Promise<GitRepositoryDiscoveryResult>;
  chooseDirectory: (sessionId: string, currentDirectory: string) => Promise<{ canceled: true } | { canceled: false; path: string }>;
  getStatus: (sessionId: string) => Promise<GitStatusResult>;
  getDiff: (sessionId: string, request: GitDiffRequest) => Promise<GitDiffResult>;
  getBranches: (sessionId: string) => Promise<GitBranchListResult>;
  getRemotes: (sessionId: string) => Promise<GitRemoteListResult>;
  checkoutBranch: (sessionId: string, branch: Pick<GitBranchEntry, "name" | "kind">, operationId: string) => Promise<GitOperationResult>;
  createBranch: (sessionId: string, branchName: string, operationId: string) => Promise<GitOperationResult>;
  getStashes: (sessionId: string) => Promise<GitStashListResult>;
  getHistory: (sessionId: string, options?: { skip?: number }) => Promise<GitHistoryResult>;
  stageFiles: (sessionId: string, paths: string[], operationId: string) => Promise<GitOperationResult>;
  stageAll: (sessionId: string, operationId: string) => Promise<GitOperationResult>;
  unstageFiles: (sessionId: string, paths: string[], operationId: string) => Promise<GitOperationResult>;
  unstageAll: (sessionId: string, operationId: string) => Promise<GitOperationResult>;
  discardWorkingTree: (sessionId: string, file: GitStatusEntry, operationId: string) => Promise<GitOperationResult>;
  commit: (sessionId: string, message: { subject: string; body?: string }, operationId: string) => Promise<GitOperationResult>;
  fetch: (sessionId: string, remote: string, operationId: string) => Promise<GitOperationResult>;
  pull: (sessionId: string, operationId: string) => Promise<GitOperationResult>;
  push: (sessionId: string, remote: string | undefined, operationId: string) => Promise<GitOperationResult>;
  stashChanges: (sessionId: string, message: string | undefined, operationId: string) => Promise<GitOperationResult>;
  applyStash: (sessionId: string, ref: string, operationId: string) => Promise<GitOperationResult>;
  popStash: (sessionId: string, ref: string, operationId: string) => Promise<GitOperationResult>;
  dropStash: (sessionId: string, ref: string, operationId: string) => Promise<GitOperationResult>;
  revertFile: (sessionId: string, file: GitStatusEntry, operationId: string) => Promise<GitOperationResult>;
  cancelOperation: (operationId: string) => Promise<boolean>;
};

export type ProjectSearchApi = {
  searchWorkspaceEntries: (sessionId: string, query: string, rootPath?: string, options?: ProjectSearchOptions) => Promise<WorkspaceEntrySearchResponse>;
  listDirectories: (sessionId: string, rootPath: string) => Promise<{
    workspaceRoot: string;
    path: string;
    directories: Array<{ name: string; path: string }>;
  }>;
  searchFiles: (sessionId: string, query: string, rootPath: string, options?: ProjectSearchOptions) => Promise<ProjectFileSearchResponse>;
  searchText: (sessionId: string, query: string, requestId: string, rootPath: string, options?: ProjectSearchOptions) => Promise<ProjectTextSearchResponse>;
  cancelTextSearch: (sessionId: string, requestId: string) => Promise<boolean>;
};

export type HookConfigApi = {
  selectProjectDirectory: (defaultPath?: string) => Promise<{ canceled: true } | { canceled: false; path: string }>;
  inspect: (target: HookInstallTarget, providers: HookProvider[]) => Promise<HookInspectionResult>;
  install: (target: HookInstallTarget, providers: HookProvider[]) => Promise<HookInspectionResult>;
};

export type DingTalkApi = {
  getConfig: () => Promise<DingTalkConfig>;
  setConfig: (input: DingTalkConfigInput) => Promise<DingTalkConfig>;
  clearCredentials: () => Promise<DingTalkConfig>;
  test: () => Promise<DingTalkTestResult>;
};

declare global {
  interface Window {
    terminalApi: TerminalApi;
    launchTemplateApi: LaunchTemplateApi;
    mobileAccessApi: MobileAccessApi;
    clipboardApi: ClipboardApi;
    externalLinkApi: ExternalLinkApi;
    remoteFileApi: RemoteFileApi;
    remoteSystemApi: RemoteSystemApi;
    agentUsageApi: AgentUsageApi;
    workBuddyCheckinApi: WorkBuddyCheckinApi;
    agentTokenStatsApi: AgentTokenStatsApi;
    remoteAgentApi: RemoteAgentApi;
    fileTransferApi: FileTransferApi;
    gitApi: GitApi;
    projectSearchApi: ProjectSearchApi;
    hookConfigApi: HookConfigApi;
    dingTalkApi: DingTalkApi;
    windowApi: WindowApi;
  }
}
