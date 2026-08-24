/// <reference types="vite/client" />

export type QuickCommand = {
  id: string;
  command: string;
  mode?: 'auto-enter' | 'write' | 'one-time';
  pinned?: boolean;
};

export type RemotePlatform = "auto" | "linux" | "windows";
export type CodexBackend = "openai" | "openrouter";

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
  remotePlatform?: RemotePlatform;
};

export type TerminalSession = {
  id: string;
  templateId?: string;
  title: string;
  shell: string;
  cwd: string;
  fileRoot?: string;
  fileSort?: FileSort;
  preferredDiskMountPoint?: string;
  createdAt: number;
  initialCommand?: string;
  agentProvider?: AgentProvider;
  agentLocation?: AgentLocation;
  localAgentCwd?: string;
  codexBackend?: CodexBackend;
  codexModel?: string;
  type: 'windows' | 'wsl' | 'ssh';
  wslDistro?: string;
  sshConfig?: SshConfig;
  quickCommands?: QuickCommand[];
  tags?: string[];
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
  autoWorkBuddyCheckin: boolean;
  debugMode: boolean;
  lastActiveSessionIds: string[];
  themeId: ThemeId;
  locale: Locale;
  rightToolsWidth: number;
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

export type OpenRouterConfig = { hasApiKey: boolean };
export type OpenRouterTestResult = {
  ok: true;
  config: OpenRouterConfig;
  keyLabel?: string;
  limitRemaining?: number;
  expiresAt?: string;
};
export type OpenRouterModel = {
  id: string;
  name: string;
  contextLength?: number;
  promptPrice?: string;
  completionPrice?: string;
};
export type OpenRouterModelList = { models: OpenRouterModel[]; fetchedAt: number };

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

export type RemoteDiskMetrics = {
  filesystem: string;
  type: string;
  mountPoint: string;
  usedBytes: number;
  totalBytes: number;
  availableBytes: number;
  usedPercent: number;
  io: {
    busyPercent: number | null;
    readBytesPerSecond: number | null;
    writeBytesPerSecond: number | null;
  };
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
  cpu: {
    usedPercent: number | null;
  };
  disks: RemoteDiskMetrics[];
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

export type GitRepositoryEntry = {
  cwd: string;
  name: string;
  relativePath: string;
};

export type GitRepositoryTarget = {
  sessionId: string;
  cwd: string;
};

export type GitWorkspaceRepository = GitRepositoryEntry & {
  snapshot?: GitRepositorySnapshot;
  error?: string;
};

export type GitWorkspaceSnapshot = {
  root: string;
  repositories: GitWorkspaceRepository[];
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

export type AgentProvider = "claude" | "codex" | "codebuddy" | "opencode" | "qoder" | "copilot" | "gemini";
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

export type AgentConversationMessage = {
  id: string;
  provider: "codex" | "codebuddy" | "gemini";
  kind: "user" | "commentary" | "final" | "reply";
  text: string;
  timestamp: number;
};

export type AgentConversationTurn = {
  sessionId: string;
  sessionTitle: string;
  provider: "codex" | "codebuddy" | "gemini";
  status: "running" | "completed" | "unsupported";
  supported: boolean;
  messages: AgentConversationMessage[];
};

export type AgentConversationSnapshot = {
  activeSessionId: string | null;
  turn: AgentConversationTurn | null;
};

export type AgentConversationHistoryItem = {
  ref: string;
  provider: "codex" | "codebuddy" | "gemini";
  title: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
};

export type AgentConversationHistoryError = {
  provider: "codex" | "codebuddy" | "gemini";
  message: string;
};

export type AgentConversationHistoryListInput = {
  panelSessionId: string;
  providers?: Array<"codex" | "codebuddy" | "gemini">;
  scope?: "cwd" | "all";
  includeArchived?: boolean;
  query?: string;
  cursor?: string | null;
  limit?: number;
};

export type AgentConversationHistoryListResult = {
  items: AgentConversationHistoryItem[];
  nextCursor: string | null;
  errors: AgentConversationHistoryError[];
};

export type AgentConversationHistoryMessagesInput = {
  panelSessionId: string;
  conversationRef: string;
  cursor?: string | null;
  limit?: number;
};

export type AgentConversationHistoryMessagesResult = {
  conversationRef: string;
  messages: AgentConversationMessage[];
  nextCursor: string | null;
};

export type AgentConversationApi = {
  setActiveSession: (sessionId?: string) => void;
  getSnapshot: () => Promise<AgentConversationSnapshot>;
  listHistory: (input: AgentConversationHistoryListInput) => Promise<AgentConversationHistoryListResult>;
  getHistoryMessages: (input: AgentConversationHistoryMessagesInput) => Promise<AgentConversationHistoryMessagesResult>;
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
  onSnapshot: (callback: (snapshot: AgentConversationSnapshot) => void) => () => void;
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
  category?: "base" | "extra" | "bonus" | "organization" | "other";
  totalAmount?: number;
  usedAmount?: number;
  remainingAmount?: number;
  unit?: "Credits";
  expiresAt?: number;
  available?: boolean;
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

export type AgentUsageActivityQuota = {
  id: string;
  name: string;
  totalAmount: number;
  usedAmount: number;
  remainingAmount: number;
  usedPercent: number;
  remainingPercent: number;
  unit: "Credits";
  expiresAt?: number;
  resetStrategy?: string;
  statusText?: string;
  tag?: string;
  description?: string;
  detailUrl?: string;
};

export type AgentUsageResetCredit = {
  id: string;
  status: "available" | "redeeming" | "redeemed" | "unknown";
  resetType: "codexRateLimits" | "unknown";
  grantedAt: number;
  title?: string;
  description?: string;
  expiresAt?: number;
};

export type AgentUsageResetCreditsSummary = {
  availableCount: number;
  credits?: AgentUsageResetCredit[];
};

export type AgentUsageSnapshot = {
  provider: "codex" | "codebuddy" | "qoder" | "gemini";
  fetchedAt: number;
  primaryLimitId: string;
  summary?: AgentUsageCreditSummary;
  resetCredits?: AgentUsageResetCreditsSummary;
  activities?: AgentUsageActivityQuota[];
  activityError?: string;
  limits: AgentUsageLimit[];
};

export type AgentUsageResetOutcome = "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit";

export type AgentUsageResetResult = {
  outcome: AgentUsageResetOutcome;
  snapshot?: AgentUsageSnapshot;
  refreshError?: string;
};

export type AgentUsageApi = {
  getUsage: (sessionId: string, options?: { force?: boolean }) => Promise<AgentUsageSnapshot>;
  consumeResetCredit: (sessionId: string, creditId: string, idempotencyKey: string) => Promise<AgentUsageResetResult>;
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

export type AgentCapabilityAvailability = "available" | "unavailable";

export type AgentCapabilityUsage = {
  skills: {
    availability: AgentCapabilityAvailability;
    totalCalls: number;
    items: Array<{ name: string; count: number }>;
  };
  mcp: {
    availability: AgentCapabilityAvailability;
    totalCalls: number;
    servers: Array<{
      name: string;
      count: number;
      tools: Array<{ name: string; count: number }>;
    }>;
  };
};

export type AgentTokenSessionRecord = {
  id: string;
  provider: "codex" | "claude" | "codebuddy" | "opencode" | "qoder" | "copilot" | "gemini";
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
  tokens: AgentTokenTotals;
  capabilities: AgentCapabilityUsage;
};

export type AgentTokenDashboard = {
  generatedAt: number;
  range: "7d" | "30d" | "all";
  provider: "all" | "codex" | "claude" | "codebuddy" | "opencode" | "qoder" | "copilot" | "gemini";
  summary: { sessionCount: number; averageTokens: number; skillCalls: number; mcpCalls: number; tokens: AgentTokenTotals };
  dailyTrend: Array<{ date: string; tokens: AgentTokenTotals }>;
  providerBreakdown: Array<{ provider: "codex" | "claude" | "codebuddy" | "opencode" | "qoder" | "copilot" | "gemini"; sessionCount: number; tokens: AgentTokenTotals }>;
  topSkills: Array<{ name: string; count: number }>;
  topMcpServers: Array<{ name: string; count: number; tools: Array<{ name: string; count: number }> }>;
  sessions: AgentTokenSessionRecord[];
  totalCount: number;
  offset: number;
  limit: number;
};

export type AgentTokenLiveSnapshot = {
  panelSessionId: string;
  provider: "codex" | "claude" | "codebuddy" | "opencode" | "qoder" | "copilot" | "gemini";
  state: "waiting" | "generating" | "completed" | "unavailable";
  tokens: AgentTokenTotals;
  capabilities: AgentCapabilityUsage;
  turnOutputTokens: number;
  outputTokensPerSecond: number;
  models: string[];
  updatedAt: number;
};

export type AgentTokenStatsApi = {
  getDashboard: (options?: { range?: "7d" | "30d" | "all"; provider?: "all" | "codex" | "claude" | "codebuddy" | "opencode" | "qoder" | "copilot" | "gemini"; offset?: number; limit?: number }) => Promise<AgentTokenDashboard>;
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

export type RemoteAgentApprovalDecision = "once" | "session" | "deny";

export type RemoteAgentApprovalRequest = {
  id: string;
  sessionId: string;
  tool: string;
  summary: string;
  timestamp: number;
};

export type RemoteAgentApi = {
  listAudit: (sessionId: string) => Promise<RemoteAgentAuditEvent[]>;
  listPendingApprovals: () => Promise<RemoteAgentApprovalRequest[]>;
  resolveApproval: (id: string, decision: RemoteAgentApprovalDecision) => Promise<boolean>;
  onAudit: (callback: (payload: RemoteAgentAuditEvent) => void) => () => void;
  onApprovalRequested: (callback: (payload: RemoteAgentApprovalRequest) => void) => () => void;
  onApprovalResolved: (callback: (payload: { id: string; decision: RemoteAgentApprovalDecision }) => void) => () => void;
};

export type TerminalApi = {
  listSessions: () => Promise<TerminalSession[]>;
  createSession: (options?: { title?: string; shell?: string; cwd?: string; cols?: number; rows?: number; initialCommand?: string; agentProvider?: AgentProvider; agentLocation?: AgentLocation; localAgentCwd?: string; codexBackend?: CodexBackend; codexModel?: string; type?: 'windows' | 'wsl' | 'ssh'; wslDistro?: string; sshConfig?: SshConfig; quickCommands?: QuickCommand[]; tags?: string[]; persist?: boolean }) => Promise<TerminalSession>;
  updateSession: (id: string, updates: { title?: string; cwd?: string; fileRoot?: string; fileSort?: FileSort; preferredDiskMountPoint?: string; initialCommand?: string; agentProvider?: AgentProvider | null; agentLocation?: AgentLocation | null; localAgentCwd?: string | null; codexBackend?: CodexBackend | null; codexModel?: string | null; sshConfig?: SshConfig; quickCommands?: QuickCommand[]; tags?: string[] }) => Promise<TerminalSession[]>;
  switchAgent: (id: string, provider: AgentProvider) => Promise<TerminalSession>;
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
  uploadImageToSession: (sessionId: string) => Promise<
    | { status: "canceled" }
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

export type SkillProvider = "codex" | "codebuddy";

export type SkillSummary = {
  id: string;
  name: string;
  description: string;
};

export type SkillsApi = {
  list: (provider: SkillProvider) => Promise<SkillSummary[]>;
};

export type McpProvider = "codex" | "codebuddy";
export type McpScope = "user" | "project-local" | "project";
export type McpTransport = "stdio" | "http" | "sse";

export type McpSecretEntry = {
  key: string;
  value: string;
  masked: boolean;
  hasValue: boolean;
};

export type McpServerDraft = {
  name: string;
  enabled: boolean;
  transport: McpTransport;
  command: string;
  args: string[];
  argsMasked: boolean;
  cwd: string;
  url: string;
  urlMasked: boolean;
  bearerTokenEnvVar: string;
  env: McpSecretEntry[];
  headers: McpSecretEntry[];
  startupTimeoutSec?: number | string;
  toolTimeoutSec?: number | string;
};

export type McpServerSummary = McpServerDraft & {
  id: string;
  provider: McpProvider;
  scope: McpScope;
};

export type McpDocument = {
  provider: McpProvider;
  scope: McpScope;
  path: string;
  projectDirectory?: string;
  version: string;
  servers: McpServerSummary[];
};

export type McpTargetRequest = {
  provider: McpProvider;
  scope: McpScope;
  sessionId?: string;
};

export type McpApi = {
  list: (request: McpTargetRequest) => Promise<McpDocument>;
  reveal: (request: McpTargetRequest & { name: string; field: "url" | "args" | "env" | "headers"; key?: string; expectedVersion: string }) => Promise<{ status: "revealed"; value: string } | { status: "conflict" }>;
  save: (request: McpTargetRequest & { originalName?: string; draft: McpServerDraft; expectedVersion: string }) => Promise<{ status: "saved"; document: McpDocument; serverName: string } | { status: "conflict" }>;
  remove: (request: McpTargetRequest & { name: string; expectedVersion: string }) => Promise<{ status: "removed"; document: McpDocument } | { status: "conflict" }>;
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
  getWorkspaceSnapshot: (sessionId: string) => Promise<GitWorkspaceSnapshot>;
  getSnapshot: (target: GitRepositoryTarget) => Promise<GitRepositorySnapshot>;
  getStatus: (target: GitRepositoryTarget) => Promise<GitStatusResult>;
  getDiff: (target: GitRepositoryTarget, request: GitDiffRequest) => Promise<GitDiffResult>;
  getBranches: (target: GitRepositoryTarget) => Promise<GitBranchListResult>;
  getRemotes: (target: GitRepositoryTarget) => Promise<GitRemoteListResult>;
  checkoutBranch: (target: GitRepositoryTarget, branch: Pick<GitBranchEntry, "name" | "kind">, operationId: string) => Promise<GitOperationResult>;
  createBranch: (target: GitRepositoryTarget, branchName: string, operationId: string) => Promise<GitOperationResult>;
  getStashes: (target: GitRepositoryTarget) => Promise<GitStashListResult>;
  getHistory: (target: GitRepositoryTarget, options?: { skip?: number }) => Promise<GitHistoryResult>;
  stageFiles: (target: GitRepositoryTarget, paths: string[], operationId: string) => Promise<GitOperationResult>;
  stageAll: (target: GitRepositoryTarget, operationId: string) => Promise<GitOperationResult>;
  unstageFiles: (target: GitRepositoryTarget, paths: string[], operationId: string) => Promise<GitOperationResult>;
  unstageAll: (target: GitRepositoryTarget, operationId: string) => Promise<GitOperationResult>;
  discardWorkingTree: (target: GitRepositoryTarget, file: GitStatusEntry, operationId: string) => Promise<GitOperationResult>;
  commit: (target: GitRepositoryTarget, message: { subject: string; body?: string }, operationId: string) => Promise<GitOperationResult>;
  fetch: (target: GitRepositoryTarget, remote: string, operationId: string) => Promise<GitOperationResult>;
  pull: (target: GitRepositoryTarget, operationId: string) => Promise<GitOperationResult>;
  push: (target: GitRepositoryTarget, remote: string | undefined, operationId: string) => Promise<GitOperationResult>;
  stashChanges: (target: GitRepositoryTarget, message: string | undefined, operationId: string) => Promise<GitOperationResult>;
  applyStash: (target: GitRepositoryTarget, ref: string, operationId: string) => Promise<GitOperationResult>;
  popStash: (target: GitRepositoryTarget, ref: string, operationId: string) => Promise<GitOperationResult>;
  dropStash: (target: GitRepositoryTarget, ref: string, operationId: string) => Promise<GitOperationResult>;
  revertFile: (target: GitRepositoryTarget, file: GitStatusEntry, operationId: string) => Promise<GitOperationResult>;
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

export type OpenRouterApi = {
  getConfig: () => Promise<OpenRouterConfig>;
  setApiKey: (apiKey: string) => Promise<OpenRouterTestResult>;
  clearApiKey: () => Promise<OpenRouterConfig>;
  test: () => Promise<OpenRouterTestResult>;
  listModels: (options?: { force?: boolean }) => Promise<OpenRouterModelList>;
};

export type IdeaExecutionMode = "run" | "debug";
export type IdeaExecutionStatus = "starting" | "running" | "stopping" | "terminated";
export type IdeaBridgeConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export type IdeaExecutionInstance = {
  id: string;
  executionId: number;
  name: string;
  mode: IdeaExecutionMode;
  status: IdeaExecutionStatus;
  startedAt: number;
};

export type IdeaRunConfiguration = {
  id: string;
  name: string;
  type: string;
  folderName?: string;
  temporary: boolean;
  allowParallel: boolean;
  supportsRun: boolean;
  supportsDebug: boolean;
  instances: IdeaExecutionInstance[];
};

export type IdeaProject = {
  id: string;
  name: string;
  path: string;
  configurations: IdeaRunConfiguration[];
};

export type IdeaBridgeConnection = {
  bridgeId: string;
  pid: number;
  productName: string;
  productVersion: string;
  buildNumber: string;
  status: IdeaBridgeConnectionStatus;
  projects: IdeaProject[];
  error?: string;
};

export type IdeaBridgeSnapshot = {
  protocolVersion: number;
  connections: IdeaBridgeConnection[];
  updatedAt: number;
};

export type IdeaBridgeOperationResult = {
  accepted: boolean;
  count?: number;
};

export type IdeaBridgeApi = {
  getSnapshot: () => Promise<IdeaBridgeSnapshot>;
  start: (bridgeId: string, projectId: string, configurationId: string, mode: IdeaExecutionMode) => Promise<IdeaBridgeOperationResult>;
  stop: (bridgeId: string, instanceId: string) => Promise<IdeaBridgeOperationResult>;
  stopAll: (bridgeId: string, projectId: string, configurationId: string) => Promise<IdeaBridgeOperationResult>;
  restart: (bridgeId: string, instanceId: string) => Promise<IdeaBridgeOperationResult>;
  onChanged: (callback: (snapshot: IdeaBridgeSnapshot) => void) => () => void;
};

declare global {
  interface Window {
    terminalApi: TerminalApi;
    agentConversationApi: AgentConversationApi;
    launchTemplateApi: LaunchTemplateApi;
    mobileAccessApi: MobileAccessApi;
    clipboardApi: ClipboardApi;
    externalLinkApi: ExternalLinkApi;
    remoteFileApi: RemoteFileApi;
    remoteSystemApi: RemoteSystemApi;
    skillsApi: SkillsApi;
    mcpApi: McpApi;
    agentUsageApi: AgentUsageApi;
    workBuddyCheckinApi: WorkBuddyCheckinApi;
    agentTokenStatsApi: AgentTokenStatsApi;
    remoteAgentApi: RemoteAgentApi;
    fileTransferApi: FileTransferApi;
    gitApi: GitApi;
    projectSearchApi: ProjectSearchApi;
    ideaBridgeApi: IdeaBridgeApi;
    hookConfigApi: HookConfigApi;
    dingTalkApi: DingTalkApi;
    openRouterApi: OpenRouterApi;
    windowApi: WindowApi;
  }
}
