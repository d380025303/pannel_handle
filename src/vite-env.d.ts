/// <reference types="vite/client" />

export type EnvironmentEntry = { name: string; value: string };
export type EnvironmentSelection = { environmentProfileId?: string | null; environmentOverrides?: EnvironmentEntry[] };
export type EnvironmentProfile = { id: string; name: string; entries: EnvironmentEntry[]; references: string[] };
export type EnvironmentPreview = EnvironmentEntry & { source: string };
export type EnvironmentApi = {
  list: () => Promise<EnvironmentProfile[]>;
  save: (input: { id?: string; name: string; entries: EnvironmentEntry[] }) => Promise<EnvironmentProfile[]>;
  delete: (id: string) => Promise<EnvironmentProfile[]>;
  preview: (input: EnvironmentSelection & { type?: string; agentProvider?: string; agentLocation?: string }) => Promise<EnvironmentPreview[]>;
};

export type QuickCommand = {
  id: string;
  command: string;
  mode?: 'auto-enter' | 'write' | 'one-time';
  pinned?: boolean;
};

export type RemotePlatform = "auto" | "linux" | "windows";

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

export type TerminalSession = EnvironmentSelection & {
  id: string;
  templateId?: string;
  title: string;
  shell: string;
  cwd: string;
  fileSort?: FileSort;
  preferredDiskMountPoint?: string;
  createdAt: number;
  initialCommand?: string;
  agentProvider?: AgentProvider;
  runtimeMode?: "terminal" | "app-server";
  agentLocation?: AgentLocation;
  localAgentCwd?: string;
  codexBackend?: CodexBackend;
  codexModel?: string;
  modelSource?: AgentModelSource;
  modelId?: string;
  codexExperimentalAcknowledged?: boolean;
  graphicalSessionEnabled?: boolean;
  codeBuddyGraphicalOptions?: { mode?: string; model?: string; contextWindow?: string; multitask?: boolean };
  openCodeGraphicalOptions?: { mode?: string; model?: string; effort?: string };
  codexExecutionPermission?: CodexExecutionPermission;
  type: 'windows' | 'wsl' | 'ssh';
  wslDistro?: string;
  sshConfig?: SshConfig;
  sshConnectionState?: "connecting" | "connected" | "reconnecting" | "disconnected";
  sshReconnectAttempt?: number;
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
export type { TitleBarActionId } from "./components/app/titleBarActions";
import type { TitleBarActionId } from "./components/app/titleBarActions";

export type WindowsShell = "cmd" | "powershell" | "pwsh";

export type AppConfig = {
  defaultWindowsShell: WindowsShell;
  autoRestore: boolean;
  autoWorkBuddyCheckin: boolean;
  autoCollapseFileChains: boolean;
  debugMode: boolean;
  screenshotEnabled: boolean;
  screenshotShortcut: string;
  titleBarActionOrder: TitleBarActionId[];
  titleBarHiddenActions: TitleBarActionId[];
  lastActiveSessionIds: string[];
  themeId: ThemeId;
  locale: Locale;
  sidebarWidth: number;
  rightToolsWidth: number;
  terminalBackgroundImage: string;
  terminalBackgroundOpacity: number;
  terminalBackgroundBlur: number;
  terminalBackgroundPositionX: number;
  terminalBackgroundPositionY: number;
};

export type MobileAccessInterface = { name: string; address: string };
export type MobileAccessConnection = { id: string; name: string; remoteAddress: string };
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
  config: { enabled: boolean; interfaceName: string; port: number; hasPassword: boolean };
  interfaces: MobileAccessInterface[];
  running: boolean;
  hostname: string;
  address: string;
  canonicalUrl: string;
  fallbackUrl: string;
  localUrl: string;
  lastError: string;
  activeConnections: MobileAccessConnection[];
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

export type RemoteOfficeFormat = "word" | "spreadsheet" | "presentation";

export type RemoteOfficePreview = {
  kind: "office";
  format: RemoteOfficeFormat;
  size: number;
  mime: string;
  previewId: string;
  url: string;
};

export type RemoteFilePreview = RemoteTextPreview | RemoteMediaPreview | RemoteOfficePreview;

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

export type AgentProvider = "claude" | "codex" | "codebuddy" | "opencode" | "qoder" | "copilot" | "gemini" | "grok";
export type CodexBackend = "openai" | "openrouter" | "nararouter" | "minimax";
export type AgentModelSource = "native" | "openrouter" | "nararouter" | "minimax";
export type CodeBuddyPromotion = { id: string; label: string; color?: string; descriptionZh?: string; descriptionEn?: string };

export type OpenRouterModel = {
  id: string;
  name: string;
  description: string;
  contextLength: number;
  inputModalities: string[];
  supportedParameters: string[];
  pricing: {
    prompt?: string;
    completion?: string;
  };
  freeTierEligible?: boolean;
  compatible: boolean;
  verification?: OpenRouterModelVerification;
  agentVerifications?: Partial<Record<"opencode" | "codebuddy", { status: "passed" | "failed" | "unavailable"; checkedAt: number; error?: string }>>;
};

export type OpenRouterModelVerification = {
  modelId?: string;
  status: "passed" | "partial" | "failed" | "unavailable";
  checkedAt: number;
  stages?: OpenRouterVerificationStage[];
  failedStage?: OpenRouterVerificationStageId;
  error?: string;
  errorKind?: OpenRouterVerificationErrorKind;
  httpStatus?: number;
  errorCode?: string;
  provider?: string;
  requestId?: string;
};

export type OpenRouterVerificationStageId = "responses" | "function_tools" | "codex_tools";
export type OpenRouterVerificationErrorKind = "unsupported" | "provider" | "rate_limit" | "timeout" | "network" | "unknown";
export type OpenRouterVerificationStage = {
  stage: OpenRouterVerificationStageId;
  status: "passed" | "failed";
  error?: string;
  errorKind?: OpenRouterVerificationErrorKind;
  httpStatus?: number;
  errorCode?: string;
  provider?: string;
  requestId?: string;
};

export type OpenRouterConfig = {
  hasApiKey: boolean;
  fetchedAt?: number;
};

export type OpenRouterApi = {
  getConfig: () => Promise<OpenRouterConfig>;
  listModels: () => Promise<OpenRouterModel[]>;
  refreshModels: () => Promise<OpenRouterModel[]>;
  saveApiKey: (apiKey: string) => Promise<OpenRouterConfig>;
  clearApiKey: () => Promise<OpenRouterConfig>;
  test: () => Promise<{ ok: true }>;
  verifyModels: (input: { modelIds: string[]; force?: boolean }) => Promise<Array<OpenRouterModelVerification & { modelId: string }>>;
  verifyAgentModels: (input: { agent: "opencode" | "codebuddy"; modelIds: string[]; force?: boolean }) => Promise<Array<{ modelId: string; status: "passed" | "failed" | "unavailable"; checkedAt: number; error?: string }>>;
};

export type NaraRouterModel = OpenRouterModel;
export type NaraRouterConfig = OpenRouterConfig;
export type NaraRouterApi = OpenRouterApi;
export type MiniMaxModel = OpenRouterModel;
export type MiniMaxConfig = OpenRouterConfig;
export type MiniMaxUsageLimit = {
  id: string;
  name: string;
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins?: number;
  total?: number;
  used?: number;
  remaining?: number;
  resetsAt?: number;
  available?: boolean;
  unlimited?: boolean;
};
export type MiniMaxUsageSnapshot = {
  provider: "minimax";
  fetchedAt: number;
  primaryLimitId: string;
  summary?: AgentUsageCurrencySummary;
  limits: MiniMaxUsageLimit[];
};
export type MiniMaxApi = OpenRouterApi & {
  getUsage: (options?: { force?: boolean }) => Promise<MiniMaxUsageSnapshot>;
};
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
  provider: "codex" | "codebuddy" | "opencode" | "gemini" | "grok";
  kind: "user" | "commentary" | "final" | "reply";
  text: string;
  timestamp: number;
};

export type AgentConversationTurn = {
  sessionId: string;
  sessionTitle: string;
  provider: "codex" | "codebuddy" | "gemini" | "grok";
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
  provider: "codex" | "codebuddy" | "opencode" | "gemini" | "grok";
  title: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
};

export type AgentConversationHistoryError = {
  provider: "codex" | "codebuddy" | "opencode" | "gemini" | "grok";
  message: string;
};

export type AgentConversationHistoryListInput = {
  panelSessionId: string;
  providers?: Array<"codex" | "codebuddy" | "opencode" | "gemini" | "grok">;
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
  unlimited?: boolean;
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

export type AgentUsageCurrencySummary = {
  kind: "currency";
  currency: "CNY";
  available: number;
  cash: number;
  voucher: number;
  credit: number;
  owed: number;
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
  provider: "codex" | "codebuddy" | "minimax" | "qoder" | "gemini";
  fetchedAt: number;
  primaryLimitId: string;
  summary?: AgentUsageCreditSummary | AgentUsageCurrencySummary;
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
  getUsage: (sessionId: string, options?: { force?: boolean }) => Promise<AgentUsageSnapshot | null>;
  getCodeBuddyUsage: (options?: { force?: boolean }) => Promise<AgentUsageSnapshot | null>;
  getCodexUsage: (options?: { force?: boolean }) => Promise<AgentUsageSnapshot | null>;
  consumeResetCredit: (sessionId: string, creditId: string, idempotencyKey: string) => Promise<AgentUsageResetResult>;
  cancel: (sessionId: string) => void;
  cancelCodeBuddyUsage: () => void;
  cancelCodexUsage: () => void;
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
  provider: "codex" | "claude" | "codebuddy" | "opencode" | "qoder" | "copilot" | "gemini" | "grok";
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
  provider: "all" | "codex" | "claude" | "codebuddy" | "opencode" | "qoder" | "copilot" | "gemini" | "grok";
  summary: { sessionCount: number; averageTokens: number; skillCalls: number; mcpCalls: number; tokens: AgentTokenTotals };
  dailyTrend: Array<{ date: string; tokens: AgentTokenTotals }>;
  providerBreakdown: Array<{ provider: "codex" | "claude" | "codebuddy" | "opencode" | "qoder" | "copilot" | "gemini" | "grok"; sessionCount: number; tokens: AgentTokenTotals }>;
  topSkills: Array<{ name: string; count: number }>;
  topMcpServers: Array<{ name: string; count: number; tools: Array<{ name: string; count: number }> }>;
  sessions: AgentTokenSessionRecord[];
  totalCount: number;
  offset: number;
  limit: number;
};

export type AgentTokenLiveSnapshot = {
  panelSessionId: string;
  provider: "codex" | "claude" | "codebuddy" | "opencode" | "qoder" | "copilot" | "gemini" | "grok";
  state: "waiting" | "generating" | "completed" | "unavailable";
  tokens: AgentTokenTotals;
  capabilities: AgentCapabilityUsage;
  turnOutputTokens: number;
  outputTokensPerSecond: number;
  outputRateAvailable?: boolean;
  models: string[];
  updatedAt: number;
};

export type AgentTokenStatsApi = {
  getDashboard: (options?: { range?: "7d" | "30d" | "all"; provider?: "all" | "codex" | "claude" | "codebuddy" | "opencode" | "qoder" | "copilot" | "gemini" | "grok"; offset?: number; limit?: number }) => Promise<AgentTokenDashboard>;
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

export type CodexWorkspaceTrustRequest = {
  id: string;
  sessionId: string;
  title: string;
  workspacePath: string;
  phase: "project" | "hooks";
  ready: boolean;
  terminalOpen: boolean;
  configPreview: string;
  scriptPreview: string;
  output: string;
  error: string;
};

export type CodexWorkspaceTrustApi = {
  listPending: () => Promise<CodexWorkspaceTrustRequest[]>;
  trustProject: (id: string) => Promise<CodexWorkspaceTrustRequest>;
  openHooks: (id: string) => Promise<CodexWorkspaceTrustRequest>;
  write: (id: string, data: string) => Promise<void>;
  resize: (id: string, cols: number, rows: number) => Promise<void>;
  finish: (id: string) => Promise<boolean>;
  cancel: (id: string) => Promise<boolean>;
  onChanged: (callback: (request: CodexWorkspaceTrustRequest) => void) => () => void;
  onOutput: (callback: (value: { id: string; data: string }) => void) => () => void;
  onResolved: (callback: (value: { id: string }) => void) => () => void;
};

export type ProjectAssistantMessage = { role: "user" | "assistant" | "system"; text: string; at: number };
export type ProjectAssistantAction = {
  action: "create_session" | "launch_saved_session" | "launch_template" | "rename_session" | "close_session" | "send_codex_input" | "switch_codex_mode";
  input: { id?: string; title?: string };
  label: string;
  createdAt: number;
};

export type CodexExecutionPermission = "readOnly" | "askApproval" | "fullAccess";
export type CodexQuestionAnswer = { answers: string[] };
export type CodexQuestionRequest = { requestId: number | string; submitting: boolean; params: {
  threadId: string; turnId: string; itemId?: string; isBlocking?: boolean; autoResolutionMs?: number | null;
  questions: Array<{ id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean; multiSelect?: boolean;
    options?: Array<{ label: string; description: string }> | null }>;
} };
export type CodexMcpElicitation = { requestId: number | string; submitting: boolean; params: {
  threadId: string; turnId?: string; serverName: string; mode: "form" | "openai/form" | "url";
  message: string; requestedSchema?: Record<string, unknown>; url?: string; elicitationId?: string;
} };

export type CodexThreadGoal = {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
};

export type CodexAppServerSnapshot = {
  threadId: string | null;
  streamId?: string;
  revision?: number;
  archived?: boolean;
  threadStatus?: { type: string; activeFlags?: string[] } | null;
  turnStatus?: string | null;
  effectiveModel?: string | null;
  errorDetails?: { message: string; kind: string; httpStatusCode: number | null;
    additionalDetails: unknown; codexErrorInfo: unknown } | null;
  diagnosticStoreError?: string | null;
  diagnostics?: Array<{ id: string; turnId: string | null; kind: string; at: number; payload: Record<string, unknown> }>;
  turnDiffs?: Array<{ turnId: string; diff: string; updatedAt: number }>;
  provider?: "codex" | "codebuddy" | "opencode" | "claude" | "qoder" | "gemini" | "grok";
  team?: { name: string | null; isAutoTeam: boolean; hasLiveMembers: boolean; members: Array<{
    name: string; color?: string; description?: string; status: string; taskId?: string; sessionId?: string;
    tokenUsage?: { inputTokens?: number; outputTokens?: number; lastContextWindow?: number }; toolCallCount?: number;
    items: CodexAppServerSnapshot["items"];
  }> } | null;
  nativeMode?: string | null;
  nativeModes?: Array<{ id: string; name: string; description?: string }>;
  acpOptions?: Array<{ id: string; name: string; description?: string; category?: string; type: string; currentValue?: string | boolean; options?: Array<{ value: string; name: string; description?: string }> }>;
  availableCommands?: Array<{ name: string; description: string }>;
  contextUsage?: { used: number; size: number; categories: Partial<Record<"systemPrompt" | "tools" | "conversation" | "mcp" | "skills", number>>; updatedAt: number } | null;
  capabilities?: { history: boolean; plan: boolean; attachments: boolean; permissions: boolean; multitask?: boolean; rewind?: boolean; supportedPermissions?: CodexExecutionPermission[] };
  model?: string | null;
  backend?: CodexBackend;
  account?: CodexAccountState | null;
  mcpRuntime?: Array<{ name: string; status: string; error: string | null; failureReason: string | null }>;
  mcpLogins?: Array<{ name: string; status: "pending" | "refreshing" | "failed"; error: string | null }>;
  mcpReload?: { status: "idle" | "reloading" | "queued" | "failed"; error: string | null };
  models?: Array<{ id: string; displayName: string; fastAvailable: boolean; defaultReasoningEffort: string | null;
    supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }> }>;
  effort?: string | null;
  fastMode?: boolean;
  tokenUsage?: { total: AgentTokenTotals; last: AgentTokenTotals; modelContextWindow: number | null } | null;
  tokenUpdatedAt?: number | null;
  turnOutputTokens?: number;
  outputTokensPerSecond?: number;
  outputRateAvailable?: boolean;
  mode: "default" | "plan";
  executionPermission: CodexExecutionPermission;
  busy: boolean;
  compacting?: boolean;
  compactionStatus?: "running" | "completed" | "failed" | null;
  goal?: CodexThreadGoal | null;
  goalLoading?: boolean;
  goalError?: string | null;
  error: string | null;
  pendingPlan: { itemId: string } | null;
  items: Array<{ id: string; type: string; turnId?: string; rewindMessageId?: string; text?: string; command?: string; output?: string; status?: string; changes?: unknown;
    toolName?: string; toolKind?: string; tool?: string; server?: string; query?: string; arguments?: unknown;
    summary?: Array<string | { text?: string }>;
    review?: string; path?: string; senderThreadId?: string; receiverThreadId?: string; newThreadId?: string;
    prompt?: string; agentStatus?: string;
    result?: unknown; locations?: Array<{ path?: string; uri?: string }>;
    attachments?: Array<{ path: string; name: string }>;
    parts?: Array<{ type: "text"; text: string } | { type: "image"; path: string; name: string }>;
    afterItemId?: string | null;
    questions?: Array<{ id: string; header: string; question: string; answers: string[] }>;
    explanation?: string | null; plan?: Array<{ step: string; status: "pending" | "inProgress" | "completed" }> }>;
  approvals: Array<{ requestId: number | string; method: string; params: { itemId?: string; reason?: string; command?: string; cwd?: string;
    networkApprovalContext?: { host?: string; protocol?: string; port?: number }; changes?: unknown; grantRoot?: string;
    permissions?: { network?: unknown; fileSystem?: unknown }; proposedExecpolicyAmendment?: string[] | null;
    availableDecisions?: Array<string | { acceptWithExecpolicyAmendment?: unknown }>;
    choices?: Array<{ id: string; label: string }> } }>;
  questions?: CodexQuestionRequest[];
  elicitations?: CodexMcpElicitation[];
};
export type CodexAppServerDelta = { id: string; streamId: string; threadId: string | null; baseRevision: number; revision: number;
  items: CodexAppServerSnapshot["items"]; turnDiffs: NonNullable<CodexAppServerSnapshot["turnDiffs"]>;
  textDeltas: Array<{ itemId: string; delta: string }> };

export type CodexAppServerHistory = { id: string; title: string; updatedAt: number; source: string; status: string; archived?: boolean; isPinned?: boolean };
export type CodexVersionState = { status: "current" | "available" | "updating" | "error";
  currentVersion?: string; latestVersion?: string; commandPath?: string; method?: "npm" | "standalone" | "unknown";
  environment: string; guidance?: string | null; error?: string; restartRequired?: boolean;
  progress?: { stage: "checking" | "installing" | "verifying" | "complete" | "failed"; output: string } };
export type CodexVersionApi = {
  check: (id: string, force?: boolean) => Promise<CodexVersionState>;
  update: (id: string) => Promise<CodexVersionState>;
};
export type CodeBuddyVersionApi = CodexVersionApi;
export type OpenCodeVersionApi = CodexVersionApi;
export type CodexPluginScope = "project" | "user";
export type CodexPluginCatalog = {
  installed: Array<Record<string, unknown>>;
  available: Array<Record<string, unknown>>;
  marketplaces: Array<Record<string, unknown>>;
  errors?: string[];
  setupRequired?: string[];
  environment: string;
};
export type CodexPluginApi = {
  list: (id: string) => Promise<CodexPluginCatalog>;
  install: (id: string, plugin: string, marketplace: string) => Promise<CodexPluginCatalog>;
  uninstall: (id: string, plugin: string, marketplace: string) => Promise<CodexPluginCatalog>;
  addMarketplace: (id: string, source: string) => Promise<CodexPluginCatalog>;
  refreshMarketplace: (id: string, name: string) => Promise<CodexPluginCatalog>;
  removeMarketplace: (id: string, name: string) => Promise<CodexPluginCatalog>;
  readConfig: (id: string, scope: CodexPluginScope) => Promise<{ overrides: Record<string, { enabled?: boolean }> }>;
  setEnabled: (id: string, scope: CodexPluginScope, input: { plugin: string; marketplace: string; enabled: boolean }) => Promise<{
    overrides: Record<string, { enabled?: boolean }>; pluginId: string; enabled: boolean }>;
};
export type CodexCapabilityReference = { kind: "skill" | "app"; name: string; path: string; token: string };
export type CodexSessionCapabilities = {
  skills: Array<{ id?: string; name: string; path: string; description: string; enabled: boolean; scope: string }>;
  apps: Array<{ id: string; name: string; description: string; accessible: boolean; enabled: boolean; callable: boolean }>;
  mcp: Array<{ name: string; status: string; authStatus: string; toolsError: string | null;
    error?: string | null; failureReason?: string | null;
    tools: Array<{ name: string; description: string }> }>;
  errors: { skills?: string; apps?: string; mcp?: string };
};

export type CodexAppServerApi = {
  snapshot: (id: string) => Promise<CodexAppServerSnapshot>;
  listModelMetadata: (id: string) => Promise<Array<{ id: string; creditMultiplier?: string; promotions: CodeBuddyPromotion[] }>>;
  readAccount: (id: string) => Promise<CodexAccountState>;
  startLogin: (id: string, type: "chatgpt" | "chatgptDeviceCode") => Promise<CodexAccountState>;
  cancelLogin: (id: string) => Promise<CodexAccountState>;
  logout: (id: string) => Promise<CodexAccountState>;
  refreshAccountUsage: (id: string) => Promise<CodexAccountState>;
  listHistory: (id: string, cursor?: string | null, archived?: boolean, isPinned?: boolean | null) => Promise<{ data: CodexAppServerHistory[]; nextCursor: string | null }>;
  readInitialUserInput: (id: string, threadId: string) => Promise<{ text: string; attachments: Array<{ path: string; name: string }> } | null>;
  renameThread: (id: string, threadId: string, name: string) => Promise<void>;
  rewind: (id: string, messageId: string, scope: "Code" | "Conversation" | "CodeAndConversation") => Promise<{
    snapshot: CodexAppServerSnapshot; filesChanged: string[]; historyRewound: boolean; fileRewindError: string | null }>;
  pinThread: (id: string, threadId: string, isPinned: boolean) => Promise<{ isPinned: boolean }>;
  forkThread: (id: string, threadId: string) => Promise<CodexAppServerSnapshot>;
  archiveThread: (id: string, threadId: string) => Promise<void>;
  unarchiveThread: (id: string, threadId: string) => Promise<void>;
  listCapabilities: (id: string, refresh?: boolean) => Promise<CodexSessionCapabilities>;
  loginMcpServer: (id: string, name: string) => Promise<{ authorizationUrl: string }>;
  reloadMcpServers: (id: string) => Promise<void>;
  resume: (id: string, threadId: string) => Promise<CodexAppServerSnapshot>;
  newThread: (id: string) => Promise<CodexAppServerSnapshot>;
  compactThread: (id: string) => Promise<CodexAppServerSnapshot>;
  listBackgroundTerminals: (id: string) => Promise<Array<{ itemId: string; processId: string; command: string; cwd: string;
    osPid: number | null; cpuPercent: number | null; rssKb: number | null }>>;
  terminateBackgroundTerminal: (id: string, processId: string) => Promise<{ terminated: boolean }>;
  cleanBackgroundTerminals: (id: string) => Promise<void>;
  getGoal: (id: string) => Promise<CodexAppServerSnapshot>;
  setGoal: (id: string, changes: { objective?: string; status?: "active" | "paused"; tokenBudget?: number | null }) => Promise<CodexAppServerSnapshot>;
  clearGoal: (id: string) => Promise<CodexAppServerSnapshot>;
  setMode: (id: string, mode: "default" | "plan") => Promise<CodexAppServerSnapshot>;
  setNativeMode: (id: string, modeId: string) => Promise<CodexAppServerSnapshot>;
  setModel: (id: string, modelId: string) => Promise<CodexAppServerSnapshot>;
  setContextWindow: (id: string, value: string) => Promise<CodexAppServerSnapshot>;
  setEffort: (id: string, effort: string) => Promise<CodexAppServerSnapshot>;
  setMultitask: (id: string, enabled: boolean) => Promise<CodexAppServerSnapshot>;
  sendTeamMessage: (id: string, teamName: string, memberName: string, text: string) => Promise<void>;
  setFastMode: (id: string, enabled: boolean) => Promise<CodexAppServerSnapshot>;
  setExecutionPermission: (id: string, permission: CodexExecutionPermission) => Promise<CodexAppServerSnapshot>;
  dismissPlan: (id: string, itemId: string) => Promise<CodexAppServerSnapshot>;
  executePlan: (id: string, itemId: string) => Promise<void>;
  chooseFiles: (id: string) => Promise<string[]>;
  previewAttachment: (id: string, filePath: string) => Promise<{ kind: "image"; dataUrl: string } | { kind: "text"; text: string }
    | { kind: "unsupported" } | { kind: "too_large"; size: number; limit: number }>;
  pasteImage: (id: string) => Promise<{ status: "no_image" } | { status: "saved"; path: string; size: number }>;
  discardImage: (id: string, filePath: string) => Promise<void>;
  submit: (id: string, text: string, filePaths?: string[], references?: CodexCapabilityReference[],
    orderedContent?: Array<{ type: "text"; text: string } | { type: "image"; path: string }>) => Promise<void>;
  interrupt: (id: string) => Promise<void>;
  resolveApproval: (id: string, requestId: number | string, decision: boolean | string) => Promise<void>;
  answerQuestion: (id: string, requestId: number | string, answers: Record<string, CodexQuestionAnswer>) => Promise<void>;
  cancelQuestion: (id: string, requestId: number | string) => Promise<void>;
  resolveElicitation: (id: string, requestId: number | string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown> | null) => Promise<void>;
  onChanged: (callback: (payload: { id: string; snapshot: CodexAppServerSnapshot }) => void) => () => void;
  onDelta: (callback: (delta: CodexAppServerDelta) => void) => () => void;
};
export type ProjectAssistantCodexSession = { id: string; title: string; type: "windows" | "wsl" | "ssh"; cwd: string; status: string };
export type ProjectAssistantCodexScreen = { sessionId: string; ansi: string; seq: number; cols: number; rows: number; owner: string };
export type ProjectAssistantCodexDelta = { seq: number; data: string };
export type ProjectAssistantSnapshot = {
  threadId: string | null;
  messages: ProjectAssistantMessage[];
  pendingAction: ProjectAssistantAction | null;
  busy: boolean;
  error: string | null;
  account?: CodexAccountState;
};
export type CodexAccountState = {
  status: "loading" | "signedOut" | "signedIn" | "notRequired";
  requiresOpenaiAuth: boolean;
  account: { type: string; email: string | null; planType: string | null } | null;
  login: { type: "chatgpt" | "chatgptDeviceCode"; loginId: string | null; url?: string; userCode?: string } | null;
  rateLimits: { rateLimits?: { limitName?: string | null; primary?: { usedPercent?: number; resetsAt?: number }; secondary?: { usedPercent?: number; resetsAt?: number } }; rateLimitsByLimitId?: Record<string, { limitName?: string | null; primary?: { usedPercent?: number; resetsAt?: number }; secondary?: { usedPercent?: number; resetsAt?: number } }> } | null;
  usage: { summary?: { lifetimeTokens?: number; peakDailyTokens?: number; longestRunningTurnSec?: number; currentStreakDays?: number; longestStreakDays?: number }; dailyUsageBuckets?: Array<{ startDate: string; tokens: number }> } | null;
  rateLimitsError: string | null;
  usageError: string | null;
  error: string | null;
};
export type ProjectAssistantApi = {
  getSnapshot: () => Promise<ProjectAssistantSnapshot>;
  start: () => Promise<void>;
  newConversation: () => Promise<ProjectAssistantSnapshot>;
  send: (text: string, sessionId?: string | null) => Promise<ProjectAssistantSnapshot>;
  resolve: (approved: boolean) => Promise<{ approved: boolean; result?: unknown }>;
  stop: () => Promise<void>;
  readAccount: () => Promise<CodexAccountState>;
  startLogin: (type: "chatgpt" | "chatgptDeviceCode") => Promise<CodexAccountState>;
  cancelLogin: () => Promise<CodexAccountState>;
  logout: () => Promise<CodexAccountState>;
  refreshAccountUsage: () => Promise<CodexAccountState>;
  listCodexSessions: () => Promise<ProjectAssistantCodexSession[]>;
  getCodexScreen: (sessionId: string) => Promise<ProjectAssistantCodexScreen>;
  getCodexDeltas: (sessionId: string, afterSeq: number) => Promise<ProjectAssistantCodexDelta[] | null>;
  writeCodex: (sessionId: string, data: string) => Promise<void>;
  submitCodex: (sessionId: string, text: string) => Promise<void>;
  switchCodexMode: (sessionId: string) => Promise<void>;
  onChanged: (callback: (snapshot: ProjectAssistantSnapshot) => void) => () => void;
  onProgress: (callback: (payload: { text: string }) => void) => () => void;
};

export type TerminalApi = {
  listSessions: () => Promise<TerminalSession[]>;
  createSession: (options?: EnvironmentSelection & { title?: string; shell?: string; windowsShell?: WindowsShell; cwd?: string; cols?: number; rows?: number; initialCommand?: string; agentProvider?: AgentProvider; agentLocation?: AgentLocation; localAgentCwd?: string; modelSource?: AgentModelSource; modelId?: string; codexBackend?: CodexBackend; codexModel?: string; codexExperimentalAcknowledged?: boolean; graphicalSessionEnabled?: boolean; type?: 'windows' | 'wsl' | 'ssh'; wslDistro?: string; sshConfig?: SshConfig; quickCommands?: QuickCommand[]; tags?: string[]; persist?: boolean }) => Promise<TerminalSession>;
  updateSession: (id: string, updates: EnvironmentSelection & { title?: string; cwd?: string; fileSort?: FileSort; preferredDiskMountPoint?: string; initialCommand?: string; agentProvider?: AgentProvider | null; agentLocation?: AgentLocation | null; localAgentCwd?: string | null; modelSource?: AgentModelSource | null; modelId?: string | null; codexBackend?: CodexBackend | null; codexModel?: string | null; codexExperimentalAcknowledged?: boolean | null; graphicalSessionEnabled?: boolean; sshConfig?: SshConfig; quickCommands?: QuickCommand[]; tags?: string[] }) => Promise<TerminalSession[]>;
  switchAgent: (id: string, provider: AgentProvider) => Promise<TerminalSession>;
  switchModelSource: (id: string, source: AgentModelSource, restart?: boolean, modelId?: string) => Promise<TerminalSession>;
  closeSession: (id: string) => Promise<TerminalSession[]>;
  reconnectSession: (id: string) => Promise<TerminalSession>;
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
  duplicateRunningSession: (id: string) => Promise<TerminalSession>;
  openOtherSessionMode: (id: string) => Promise<TerminalSession>;
  reorderRunningSessions: (orderedIds: string[]) => Promise<TerminalSession[]>;
  getConfig: () => Promise<AppConfig>;
  setConfig: (partial: Partial<AppConfig>) => Promise<AppConfig>;
  chooseTerminalBackgroundImage: () => Promise<
    { canceled: true } | { canceled: false; name?: string; error?: string }
  >;
};

export type SessionShellApi = {
  open: (id: string, ownerToken: string) => Promise<{ generation: number; history: string; seq: number }>;
  close: (id: string, ownerToken: string) => Promise<void>;
  write: (id: string, generation: number, data: string) => void;
  resize: (id: string, generation: number, cols: number, rows: number) => void;
  onData: (callback: (payload: { id: string; generation: number; seq: number; data: string }) => void) => () => void;
  onExit: (callback: (payload: { id: string; generation: number; exitCode: number }) => void) => () => void;
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

export type PostgresBackupConfig = {
  deviceId: string; deviceName: string; enabled: boolean; host: string; port: number;
  database: string; user: string; ssl: boolean; hasPassword: boolean; hasPassphrase: boolean;
  lastSuccessAt: number | null; lastError: string; pendingSources: string[]; running: boolean;
};
export type PostgresBackupApi = {
  getConfig: () => Promise<PostgresBackupConfig>;
  saveConfig: (input: Partial<PostgresBackupConfig> & { password?: string; passphrase?: string }) => Promise<PostgresBackupConfig>;
  testConnection: (input?: Partial<PostgresBackupConfig> & { password?: string }) => Promise<{ ok: boolean; error?: string }>;
  run: () => Promise<PostgresBackupConfig>;
  listDevices: () => Promise<Array<{ id: string; name: string; last_seen_at: string }>>;
  getDashboard: (options?: { deviceId?: string; range?: "7d" | "30d" | "all"; provider?: string; offset?: number; limit?: number }) => Promise<AgentTokenDashboard>;
  listSnapshots: (deviceId: string) => Promise<Array<{ id: string; device_id: string; created_at: string; session_count: number }>>;
  restore: (id: string, passphrase?: string) => Promise<{ importedCount: number; sessions: TerminalSession[] }>;
  listConversations: (deviceId: string, offset?: number) => Promise<Array<{ source_key: string; conversation_ref: string; metadata: AgentConversationHistoryItem }>>;
  getMessages: (deviceId: string, sourceKey: string, ref: string, offset?: number) => Promise<AgentConversationMessage[]>;
  deleteDevice: (deviceId: string) => Promise<boolean>;
  onChanged: (callback: (value: PostgresBackupConfig) => void) => () => void;
};

export type ScreenshotApi = {
  captureRegion: () => Promise<{ status: "launched" }>;
};

export type MobileAccessApi = {
  getState: () => Promise<MobileAccessState>;
  updateConfig: (partial: Partial<MobileAccessState["config"]>) => Promise<MobileAccessState>;
  setPassword: (password: string) => Promise<MobileAccessState>;
  listAudit: () => Promise<MobileAccessAuditEntry[]>;
  disconnectConnection: (connectionId: string) => Promise<MobileAccessState>;
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
export type SkillSource = "project" | "personal" | "system" | "plugin";

export type SkillSummary = {
  id: string;
  name: string;
  description: string;
  path: string;
  source: SkillSource;
  enabled: boolean;
};

export type SkillsCatalog = {
  skills: SkillSummary[];
  pluginStatus: "available" | "requires-session" | "not-applicable";
  projectStatus: "available" | "no-session" | "remote-unavailable" | "not-applicable";
  projectPath?: string;
};

export type SkillsApi = {
  list: (provider: SkillProvider, sessionId?: string) => Promise<SkillsCatalog>;
};

export type McpProvider = "codex" | "opencode" | "codebuddy";
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
  copy: (request: { source: McpTargetRequest; name: string; expectedSourceVersion: string; expectedDestinationVersion: string }) => Promise<{ status: "copied"; document: McpDocument; serverName: string; permissionsCopied: boolean } | { status: "conflict" } | { status: "exists" }>;
};

export type SessionStatusMcpState = { enabled: boolean; running: boolean; url: string; error: string };
export type SessionStatusMcpApi = {
  get: () => Promise<SessionStatusMcpState>;
  setEnabled: (enabled: boolean) => Promise<SessionStatusMcpState>;
  revealToken: () => Promise<string>;
  onChanged: (callback: (value: SessionStatusMcpState) => void) => () => void;
};

export type FileTransferApi = {
  list: () => Promise<FileTransferTask[]>;
  chooseUpload: (sessionId: string, remoteDir: string) => Promise<{ canceled: true } | { canceled: false; tasks: FileTransferTask[] }>;
  uploadDroppedFiles: (sessionId: string, remoteDir: string, files: FileList | File[]) => Promise<{ canceled: false; tasks: FileTransferTask[] }>;
  chooseDownload: (sessionId: string, remotePath: string, fileName?: string) => Promise<{ canceled: true } | { canceled: false; task: FileTransferTask }>;
  chooseDownloadBatch: (sessionId: string, entries: RemoteFileEntry[]) => Promise<{ canceled: true } | { canceled: false; tasks: FileTransferTask[] }>;
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
  pull: (target: GitRepositoryTarget, remote: string | undefined, operationId: string) => Promise<GitOperationResult>;
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
    projectAssistantApi: ProjectAssistantApi;
    codexPluginApi: CodexPluginApi;
    codexAppServerApi: CodexAppServerApi;
    codexVersionApi: CodexVersionApi;
    codeBuddyVersionApi: CodeBuddyVersionApi;
    openCodeVersionApi: OpenCodeVersionApi;
    environmentApi: EnvironmentApi;
    terminalApi: TerminalApi;
    sessionShellApi: SessionShellApi;
    screenshotApi: ScreenshotApi;
    agentConversationApi: AgentConversationApi;
    launchTemplateApi: LaunchTemplateApi;
    mobileAccessApi: MobileAccessApi;
    clipboardApi: ClipboardApi;
    externalLinkApi: ExternalLinkApi;
    remoteFileApi: RemoteFileApi;
    remoteSystemApi: RemoteSystemApi;
    skillsApi: SkillsApi;
    mcpApi: McpApi;
    sessionStatusMcpApi: SessionStatusMcpApi;
    agentUsageApi: AgentUsageApi;
    workBuddyCheckinApi: WorkBuddyCheckinApi;
    agentTokenStatsApi: AgentTokenStatsApi;
    postgresBackupApi: PostgresBackupApi;
    remoteAgentApi: RemoteAgentApi;
    codexWorkspaceTrustApi: CodexWorkspaceTrustApi;
    fileTransferApi: FileTransferApi;
    gitApi: GitApi;
    projectSearchApi: ProjectSearchApi;
    ideaBridgeApi: IdeaBridgeApi;
    hookConfigApi: HookConfigApi;
    dingTalkApi: DingTalkApi;
    openRouterApi: OpenRouterApi;
    naraRouterApi: NaraRouterApi;
    miniMaxApi: MiniMaxApi;
    windowApi: WindowApi;
  }
}
