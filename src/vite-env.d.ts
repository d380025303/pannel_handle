/// <reference types="vite/client" />

export type ProjectTool = {
  name: string;
  group: "owners" | "sessions" | "remote";
  description: string;
  summary: { "zh-CN": string; "en-US": string };
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
  example: Record<string, unknown>;
  conditions: { "zh-CN": string; "en-US": string };
  result: { "zh-CN": string; "en-US": string };
  resultExample: unknown;
};

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

export type SessionCreationSource = {
  kind: "module-owner-task" | "work-item";
  trigger: "scheduled" | "manual";
  templateId: string;
  ownerId: string;
  ownerName: string;
  taskId: string;
  taskName: string;
  workItemId?: string;
  attemptId?: string;
};

export type TerminalSession = EnvironmentSelection & {
  id: string;
  templateId?: string;
  creationSource?: SessionCreationSource;
  ignoredCodexConfigWarnings?: string[];
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
  openCodeAdditionalDirectories?: string[];
  codexBackend?: CodexBackend;
  codexModel?: string;
  modelSource?: AgentModelSource;
  modelId?: string;
  codexExperimentalAcknowledged?: boolean;
  graphicalSessionEnabled?: boolean;
  codeBuddyGraphicalOptions?: { mode?: string; model?: string; contextWindow?: string; multitask?: boolean };
  openCodeGraphicalOptions?: { mode?: string; model?: string; effort?: string };
  codexExecutionPermission?: CodexExecutionPermission;
  codexPermissionProfileId?: string;
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
  autoQoderCheckin: boolean;
  autoCollapseFileChains: boolean;
  debugMode: boolean;
  graphicalSessionMinimalMode: boolean;
  mobileGraphicalSessionMinimalMode: boolean;
  graphicalMenuSecondaryActions?: import("./utils/graphicalMenu").GraphicalMenuConfig;
  desktopMascotEnabled: boolean;
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
  comparisonBase?: "ours";
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
  provider: AgentProvider;
  kind: "user" | "commentary" | "final" | "reply" | "reasoning" | "tool" | "summary";
  threadId?: string;
  itemType?: string;
  turnId?: string;
  status?: string;
  item?: Record<string, unknown>;
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
  provider: AgentProvider;
  title: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  status?: "running" | "ended" | "failed" | "interrupted";
  captureStatus?: "waiting" | "supported" | "unsupported" | "error";
  captureError?: string | null;
  location?: string;
  mode?: "terminal" | "graphical";
  endedAt?: number | null;
  threadIds?: string[];
};

export type AgentConversationHistoryError = {
  provider: AgentProvider;
  message: string;
};

export type AgentConversationHistoryListInput = {
  panelSessionId?: string;
  providers?: AgentProvider[];
  source?: "archive" | "cli";
  cwd?: string;
  windows?: boolean;
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
  panelSessionId?: string;
  conversationRef: string;
  cursor?: string | null;
  limit?: number;
};

export type AgentConversationHistoryMessagesResult = {
  conversationRef: string;
  messages: AgentConversationMessage[];
  nextCursor: string | null;
};

export type AgentConversationAppend = {
  sessionId: string;
  startIndex: number;
  messages: AgentConversationMessage[];
};

export type AgentConversationApi = {
  setActiveSession: (sessionId?: string) => void;
  getSnapshot: () => Promise<AgentConversationSnapshot>;
  listHistory: (input: AgentConversationHistoryListInput) => Promise<AgentConversationHistoryListResult>;
  getHistoryMessages: (input: AgentConversationHistoryMessagesInput) => Promise<AgentConversationHistoryMessagesResult>;
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
  onAppend: (callback: (update: AgentConversationAppend) => void) => () => void;
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
  qoderSource?: "desktop" | "cli";
  qoderRewardDetailsStatus?: "available" | "unavailable";
  qoderAccount?: { id: string; label: string };
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

export type QoderCheckinStatus = {
  accountId: string;
  accountLabel: string;
  active: boolean;
  claimable: boolean;
  todayCheckedIn: boolean;
  dailyCredit: number;
  windowStart: number;
  nextClaimAt: number;
  campaignId?: string;
};
export type QoderCheckinApi = {
  getStatus: (accountId?: string) => Promise<QoderCheckinStatus>;
  claim: (accountId?: string) => Promise<{ alreadyCheckedIn: boolean; status: QoderCheckinStatus }>;
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
  persistent?: boolean;
  hostTrustLabel?: string;
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

export type CodexConfigSection<T> = { status: "loading" | "ready" | "error" | "unsupported"; data: T | null; error?: string };
export type CodexPermissionOption = { id: string; allowed: boolean; reason: string | null; description?: string | null };
export type CodexConfigurationView = {
  cwd: string;
  config?: CodexConfigSection<{ values: Record<string, unknown>; layers: Array<{ type: string | null; path: string | null; disabled: boolean; values: Record<string, unknown> }> }>;
  requirements: CodexConfigSection<Record<string, unknown>>;
  profiles: CodexConfigSection<CodexPermissionOption[]>;
  legacy: CodexPermissionOption[];
  runtime: { model?: string | null; effort?: string | null; mode: string; executionPermission: CodexExecutionPermission; permissionProfileId: string | null };
  permissionError?: string | null;
};
export type CodexExecutionPermission = "readOnly" | "askApproval" | "fullAccess";
export type CodexQuestionAnswer = { answers: string[]; customAnswer?: string };
export type CodexQuestionRequest = { requestId: number | string; submitting: boolean; params: {
  threadId: string; turnId: string; itemId?: string; isBlocking?: boolean; autoResolutionMs?: number | null;
  questions: Array<{ id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean; multiSelect?: boolean; required?: boolean;
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

export type CodeBuddyGoalState = {
  available: boolean;
  active: { condition: string; paused: boolean; durationMs: number; turnCount: number; tokenDelta: number; reason: string } | null;
  latest: { condition: string; ok: boolean; reason: string; durationMs: number; turnCount: number; tokenDelta: number } | null;
  pendingAction: "set" | "clear" | "inspect" | null;
  error: string | null;
  updatedAt: number;
};

export type CodexReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string }
  | { type: "custom"; instructions: string };

export type CodexWindowsSandboxSetup = {
  available: boolean;
  mode: "elevated" | "unelevated";
  status: "idle" | "running" | "succeeded" | "failed";
  error: string | null;
};
export type CodexSubAgents = {
  expanded: boolean; selectedThreadId: string | null; loading: boolean; error: string | null; warning: string | null;
  members: Array<{ threadId: string; parentThreadId: string; name: string; role: string; task: string; status: string;
    createdAt: number; loading: boolean; error: string | null; items: CodexAppServerSnapshot["items"] }>;
};

export type OpenCodeAuthState = {
  status: "idle" | "running" | "reconnecting" | "succeeded" | "failed" | "cancelled";
  generation: number;
  error: string | null;
};

export type OpenCodeAuthApi = {
  start: (id: string, methodId: string) => Promise<{ generation: number; history: string; seq: number }>;
  cancel: (id: string, generation: number) => Promise<void>;
  write: (id: string, generation: number, data: string) => void;
  resize: (id: string, generation: number, cols: number, rows: number) => void;
  onData: (callback: (payload: { id: string; generation: number; seq: number; data: string }) => void) => () => void;
  onState: (callback: (payload: OpenCodeAuthState & { id: string }) => void) => () => void;
};

export type CodeBuddySideQuestion = { requestId: string; threadId: string; question: string;
  status: "running" | "completed" | "failed" | "cancelled"; answer: string; error: string | null; truncated: boolean };

export type CodexAppServerSnapshot = {
  sideQuestion?: CodeBuddySideQuestion | null;
  acpAuth?: OpenCodeAuthState & { required: boolean; methods: Array<{ id: string; name: string; description: string }> };
  subAgents?: CodexSubAgents;
  windowsSandboxSetup?: CodexWindowsSandboxSetup;
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
  mainAgent?: { currentAgentName: string | null; sessionBlank: boolean; changing?: boolean; error: string | null;
    agents: Array<{ name: string; displayName: string; description?: string; source?: string; broken?: string }> } | null;
  nativeMode?: string | null;
  nativeModes?: Array<{ id: string; name: string; description?: string }>;
  acpOptions?: Array<{ id: string; name: string; description?: string; category?: string; type: string; currentValue?: string | boolean; options?: Array<{ value: string; name: string; description?: string }> }>;
  availableCommands?: Array<{ name: string; description: string }>;
  contextUsage?: { used: number; size: number; categories: Partial<Record<"systemPrompt" | "tools" | "conversation" | "mcp" | "skills", number>>; updatedAt: number } | null;
  openCodeRetry?: { attempt: number; nextRetryAt: string | null; error: { type: string; message: string; status?: number } } | null;
  openCodeRevert?: { messageID: string; files?: unknown[] } | null;
  historyActionsError?: string | null;
  capabilities?: { history: boolean; forkHistory?: boolean; deleteHistory?: boolean; renameHistory?: boolean; revertHistory?: boolean; plan: boolean; attachments: boolean; permissions: boolean; multitask?: boolean; sideQuestion?: boolean; rewind?: boolean; supportedPermissions?: CodexExecutionPermission[] };
  model?: string | null;
  backend?: CodexBackend;
  account?: CodexAccountState | null;
  mcpRuntime?: Array<{ name: string; status: string; error: string | null; failureReason: string | null }>;
  mcpLogins?: Array<{ name: string; status: "pending" | "refreshing" | "failed"; error: string | null }>;
  mcpReload?: { status: "idle" | "reloading" | "queued" | "failed"; error: string | null };
  models?: Array<{ id: string; displayName: string; inputModalities?: string[]; fastAvailable: boolean; defaultReasoningEffort: string | null;
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
  permissionProfileId?: string | null;
  permissionError?: string | null;
  changingPermission?: boolean;
  permissionOptions?: CodexPermissionOption[];
  busy: boolean;
  compacting?: boolean;
  reviewing?: boolean;
  compactionStatus?: "running" | "completed" | "failed" | null;
  goal?: CodexThreadGoal | null;
  codeBuddyGoal?: CodeBuddyGoalState;
  goalLoading?: boolean;
  goalError?: string | null;
  error: string | null;
  pendingPlan: { itemId: string } | null;
  items: Array<{ id: string; type: string; turnId?: string; rewindMessageId?: string; text?: string; command?: string; output?: string; status?: string; durationMs?: number; savedPath?: string | null; changes?: unknown;
    toolName?: string; toolKind?: string; tool?: string; server?: string; query?: string; arguments?: unknown;
    summary?: Array<string | { text?: string }>;
    compactionId?: string; compactionSummary?: unknown[]; compactionError?: string; compactionSource?: string;
    review?: string; path?: string; agentThreadId?: string; agentPath?: string; kind?: string; receiverThreadIds?: string[]; agentsStates?: Record<string, { status: string; message?: string | null }>; senderThreadId?: string; receiverThreadId?: string; newThreadId?: string;
    prompt?: string; agentStatus?: string;
    mcpApp?: { serverName: string; resourceUri: string; revision?: number };
    result?: unknown; toolContent?: unknown[]; locations?: Array<{ path?: string; uri?: string; line?: number }>;
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
export type CodexSubAgentTextDelta = { threadId: string; itemId: string; field: "text" | "output" | "summary";
  delta: string; summaryIndex?: number };
export type CodexAppServerDelta = { id: string; streamId: string; threadId: string | null; baseRevision: number; revision: number;
  items: CodexAppServerSnapshot["items"]; turnDiffs: NonNullable<CodexAppServerSnapshot["turnDiffs"]>;
  textDeltas: Array<{ itemId: string; delta: string; memberName?: string }>; summaryDeltas?: Array<{ itemId: string; summaryIndex: number; delta: string }>; subAgentTextDeltas?: CodexSubAgentTextDelta[] };

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
export type CodeBuddyPluginScope = "user" | "project" | "local";
export type CodeBuddyPluginCatalog = {
  installed: Array<{ id: string; name: string; marketplaceName: string; scope: CodeBuddyPluginScope | "managed";
    enabled: boolean; version: string; dependencyErrors: string[] }>;
  available: Array<{ name: string; marketplaceName: string; description?: string; version?: string }>;
  marketplaces: Array<{ name: string; source?: string | Record<string, unknown>; description?: string;
    isBuiltIn?: boolean; autoUpdate?: boolean }>;
  errors: string[]; environment: string; reloadError?: string;
};
export interface CodeBuddyMcpRuntime {
  threadId: string | null;
  statuses: Array<{ name: string; status: string; error: string | null; updatedAt: number }>;
  supported: boolean;
  reason: string;
}
export interface CodeBuddyMcpAppData {
  toolName?: string; toolResourceUri?: string; html?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: { content: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean };
  csp?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[]; baseUriDomains?: string[] };
}
export interface CodeBuddyMcpApi {
  restart(id: string): Promise<CodexAppServerSnapshot>;
  images(id: string, threadId: string, itemId: string, images: Array<{ data: string; mimeType: string }>): Promise<string[]>;
  runtime(id: string): Promise<CodeBuddyMcpRuntime>;
  load(id: string, threadId: string, itemId: string): Promise<CodeBuddyMcpAppData>;
  read(id: string, threadId: string, itemId: string, uri: string): Promise<{ contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string; _meta?: { ui?: { csp?: CodeBuddyMcpAppData["csp"] } } }> }>;
  prepare(id: string, threadId: string, itemId: string, name: string, args: Record<string, unknown>): Promise<{ token: string; serverName: string; toolName: string; arguments: Record<string, unknown> }>;
  resolve(id: string, token: string, approved: boolean): Promise<{ content: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean }>;
  dispose(id: string, threadId: string, itemId: string): Promise<void>;
}

export type CodeBuddyPluginApi = {
  list: (id: string) => Promise<CodeBuddyPluginCatalog>;
  reload: (id: string) => Promise<CodeBuddyPluginCatalog>;
  install: (id: string, name: string, marketplace: string, scope: CodeBuddyPluginScope) => Promise<CodeBuddyPluginCatalog>;
  uninstall: (id: string, name: string, marketplace: string, scope: CodeBuddyPluginScope) => Promise<CodeBuddyPluginCatalog>;
  enable: (id: string, name: string, marketplace: string, scope: CodeBuddyPluginScope) => Promise<CodeBuddyPluginCatalog>;
  disable: (id: string, name: string, marketplace: string, scope: CodeBuddyPluginScope) => Promise<CodeBuddyPluginCatalog>;
  update: (id: string, name: string, marketplace: string, scope: CodeBuddyPluginScope) => Promise<CodeBuddyPluginCatalog>;
  addMarketplace: (id: string, source: string, name: string, autoUpdate: boolean) => Promise<CodeBuddyPluginCatalog>;
  refreshMarketplace: (id: string, name: string) => Promise<CodeBuddyPluginCatalog>;
  removeMarketplace: (id: string, name: string) => Promise<CodeBuddyPluginCatalog>;
  setAutoUpdate: (id: string, name: string, enabled: boolean) => Promise<CodeBuddyPluginCatalog>;
};
export type CodexCapabilityReference = { kind: "skill" | "app"; name: string; path: string; token: string };
export type CodexPluginDetail = { name: string; marketplaceName: string; description: string; version: string | null;
  source: { type?: string } | null; installed: boolean; enabled: boolean; shareUrl: string | null; remotePluginId: string | null;
  skills: Array<{ name: string; description: string; enabled: boolean }>;
  apps: Array<{ name: string }>; mcpServers: string[] };
export type CodexAppDetail = { id: string; name: string; description: string; accessible: boolean; enabled: boolean; callable: boolean;
  distributionChannel: string | null; installUrl: string | null; pluginDisplayNames: string[];
  tools: Array<{ name: string; title: string; description: string; enabled: boolean; disabledReason: string | null; readOnly: boolean }> };
export type CodexMcpResourceResult = { contents: Array<{ uri: string; mimeType: string | null; text: string | null; binary: boolean; truncated: boolean }>; truncated: boolean };
export type CodexSessionCapabilities = {
  skills: Array<{ id?: string; name: string; path: string; description: string; enabled: boolean; scope: string }>;
  apps: Array<{ id: string; name: string; description: string; accessible: boolean; enabled: boolean; callable: boolean }>;
  mcp: Array<{ name: string; status: string; authStatus: string; toolsError: string | null;
    error?: string | null; failureReason?: string | null;
    pluginId?: string | null; httpOrigin?: string | null; serverInfo?: { name?: string; version?: string } | null;
    resources: Array<{ uri: string; name: string; description: string; mimeType: string | null }>;
    resourceTemplates: Array<{ uriTemplate: string; name: string; description: string }>;
    tools: Array<{ name: string; description: string }> }>;
  errors: { skills?: string; apps?: string; mcp?: string };
};

export type CodexAppServerApi = {
  listScheduledTasks: (id: string, threadId: string) => Promise<CodeBuddyScheduledTask[]>;
  createScheduledTask: (id: string, threadId: string, input: CodeBuddyScheduledTaskInput) => Promise<void>;
  deleteScheduledTask: (id: string, threadId: string, taskId: string) => Promise<void>;
  listJobs: (id: string) => Promise<CodeBuddyJob[]>;
  jobDispatchContext: (id: string) => Promise<CodeBuddyJobDispatchContext>;
  listResumableJobs: (id: string) => Promise<CodeBuddyResumableJob[]>;
  dispatchJob: (id: string, input: CodeBuddyJobDispatch) => Promise<unknown>;
  resumeJob: (id: string, sessionId: string) => Promise<unknown>;
  jobTranscript: (id: string, jobId: string) => Promise<{ sessionId: string | null; updates: Array<Record<string, unknown>> }>;
  jobAction: (id: string, jobId: string, action: "reply" | "stop" | "respawn" | "rename" | "delete", input?: { text?: string; name?: string }) => Promise<unknown>;
  watchJob: (id: string, jobId: string) => Promise<void>;
  unwatchJob: (id: string, jobId: string) => Promise<void>;
  onJobsEvent: (callback: (event: { cwd: string; type: string }) => void) => () => void;
  onJobTranscript: (callback: (event: { cwd: string; jobId: string; event?: Record<string, unknown>; error?: string; reset?: boolean }) => void) => () => void;
  setupWindowsSandbox: (id: string, mode: "elevated" | "unelevated") => Promise<CodexAppServerSnapshot>;
  snapshot: (id: string) => Promise<CodexAppServerSnapshot>;
  listModelMetadata: (id: string) => Promise<Array<{ id: string; creditMultiplier?: string; promotions: CodeBuddyPromotion[] }>>;
  readAccount: (id: string) => Promise<CodexAccountState>;
  startLogin: (id: string, type: "chatgpt" | "chatgptDeviceCode") => Promise<CodexAccountState>;
  cancelLogin: (id: string) => Promise<CodexAccountState>;
  logout: (id: string) => Promise<CodexAccountState>;
  refreshAccountUsage: (id: string) => Promise<CodexAccountState>;
  readConfiguration: (id: string) => Promise<CodexConfigurationView>;
  setPermissionProfile: (id: string, profileId: string) => Promise<CodexAppServerSnapshot>;
  listHistory: (id: string, cursor?: string | null, archived?: boolean, isPinned?: boolean | null) => Promise<{ data: CodexAppServerHistory[]; nextCursor: string | null }>;
  readInitialUserInput: (id: string, threadId: string) => Promise<{ text: string; attachments: Array<{ path: string; name: string }> } | null>;
  revertThread: (id: string, messageId: string) => Promise<CodexAppServerSnapshot>;
  restoreThread: (id: string) => Promise<CodexAppServerSnapshot>;
  renameThread: (id: string, threadId: string, name: string) => Promise<void>;
  rewind: (id: string, messageId: string, scope: "Code" | "Conversation" | "CodeAndConversation") => Promise<{
    snapshot: CodexAppServerSnapshot; filesChanged: string[]; historyRewound: boolean; fileRewindError: string | null }>;
  pinThread: (id: string, threadId: string, isPinned: boolean) => Promise<{ isPinned: boolean }>;
  forkTurnToNewSession: (id: string, threadId: string, turnId: string) => Promise<TerminalSession>;
  forkThread: (id: string, threadId: string, lastTurnId?: string) => Promise<CodexAppServerSnapshot>;
  deleteThread: (id: string, threadId: string) => Promise<void>;
  archiveThread: (id: string, threadId: string) => Promise<void>;
  unarchiveThread: (id: string, threadId: string) => Promise<void>;
  listCapabilities: (id: string, refresh?: boolean) => Promise<CodexSessionCapabilities>;
  setSkillEnabled: (id: string, path: string, enabled: boolean) => Promise<void>;
  readPluginDetail: (id: string, plugin: string, marketplace: string) => Promise<CodexPluginDetail>;
  readPluginSkill: (id: string, plugin: string, marketplace: string, skill: string) => Promise<{ contents: string | null; truncated: boolean }>;
  readAppDetail: (id: string, appId: string) => Promise<CodexAppDetail>;
  readMcpResource: (id: string, server: string, uri: string) => Promise<CodexMcpResourceResult>;
  loginMcpServer: (id: string, name: string) => Promise<{ authorizationUrl: string }>;
  reloadMcpServers: (id: string) => Promise<void>;
  resume: (id: string, threadId: string) => Promise<CodexAppServerSnapshot>;
  newThread: (id: string) => Promise<CodexAppServerSnapshot>;
  compactThread: (id: string) => Promise<CodexAppServerSnapshot>;
  startReview: (id: string, target: CodexReviewTarget) => Promise<void>;
  listBackgroundTerminals: (id: string) => Promise<Array<{ itemId: string; processId: string; command: string; cwd: string;
    osPid: number | null; cpuPercent: number | null; rssKb: number | null }>>;
  terminateBackgroundTerminal: (id: string, processId: string) => Promise<{ terminated: boolean }>;
  cleanBackgroundTerminals: (id: string) => Promise<void>;
  getGoal: (id: string) => Promise<CodexAppServerSnapshot>;
  setGoal: (id: string, changes: { objective?: string; status?: "active" | "paused"; tokenBudget?: number | null }) => Promise<CodexAppServerSnapshot>;
  clearGoal: (id: string) => Promise<CodexAppServerSnapshot>;
  refreshGoal: (id: string) => Promise<CodexAppServerSnapshot>;
  setMode: (id: string, mode: "default" | "plan") => Promise<CodexAppServerSnapshot>;
  setNativeMode: (id: string, modeId: string) => Promise<CodexAppServerSnapshot>;
  setModel: (id: string, modelId: string) => Promise<CodexAppServerSnapshot>;
  listMainAgents: (id: string) => Promise<CodexAppServerSnapshot>;
  setMainAgent: (id: string, agentName: string) => Promise<CodexAppServerSnapshot>;
  setContextWindow: (id: string, value: string) => Promise<CodexAppServerSnapshot>;
  setEffort: (id: string, effort: string) => Promise<CodexAppServerSnapshot>;
  setMultitask: (id: string, enabled: boolean) => Promise<CodexAppServerSnapshot>;
  setSubAgentView: (id: string, expanded: boolean, threadId?: string | null, rootThreadId?: string) => Promise<void>;
  refreshSubAgents: (id: string, rootThreadId?: string) => Promise<void>;
  sendTeamMessage: (id: string, teamName: string, memberName: string, text: string) => Promise<void>;
  setFastMode: (id: string, enabled: boolean) => Promise<CodexAppServerSnapshot>;
  setExecutionPermission: (id: string, permission: CodexExecutionPermission) => Promise<CodexAppServerSnapshot>;
  dismissPlan: (id: string, itemId: string) => Promise<CodexAppServerSnapshot>;
  executePlan: (id: string, itemId: string) => Promise<void>;
  chooseFiles: (id: string) => Promise<string[]>;
  previewAttachment: (id: string, filePath: string) => Promise<{ kind: "image"; dataUrl: string } | { kind: "text"; text: string }
    | { kind: "unsupported" } | { kind: "too_large"; size: number; limit: number }>;
  pasteImage: (id: string, image?: { name: string; bytes: Uint8Array }) => Promise<{ status: "no_image" } | { status: "saved"; path: string; size: number }>;
  discardImage: (id: string, filePath: string) => Promise<void>;
  askSideQuestion: (id: string, question: string) => Promise<CodexAppServerSnapshot>;
  cancelSideQuestion: (id: string, requestId: string) => Promise<CodexAppServerSnapshot>;
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
export type CodeBuddyJob = { id: string; cwd: string; name?: string; prompt?: string; state?: string; status?: string;
  tempo?: string; alive?: boolean; settled?: boolean; sessionId?: string; firstTerminalAt?: number; createdAt?: number };
export type CodeBuddyResumableJob = { sessionId: string; cwd: string; title?: string; updatedAt?: number };
export type CodeBuddyJobDispatchContext = { cwd?: string; defaultAgentName?: string; permissionMode?: string;
  agents?: Array<{ name?: string; id?: string; description?: string }>; repoTargets?: Array<{ path?: string; cwd?: string; name?: string }> };
export type CodeBuddyJobDispatch = { prompt: string; name?: string; agent?: string; model?: string;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";
  bgIsolation?: "none" | "worktree" };
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
export type TerminalApi = {
  listSessions: () => Promise<TerminalSession[]>;
  createSession: (options?: EnvironmentSelection & { title?: string; shell?: string; windowsShell?: WindowsShell; cwd?: string; cols?: number; rows?: number; initialCommand?: string; agentProvider?: AgentProvider; agentLocation?: AgentLocation; localAgentCwd?: string; openCodeAdditionalDirectories?: string[]; modelSource?: AgentModelSource; modelId?: string; codexBackend?: CodexBackend; codexModel?: string; codexExperimentalAcknowledged?: boolean; graphicalSessionEnabled?: boolean; type?: 'windows' | 'wsl' | 'ssh'; wslDistro?: string; sshConfig?: SshConfig; quickCommands?: QuickCommand[]; tags?: string[]; persist?: boolean }) => Promise<TerminalSession>;
  updateSession: (id: string, updates: EnvironmentSelection & { title?: string; cwd?: string; fileSort?: FileSort; preferredDiskMountPoint?: string; initialCommand?: string; agentProvider?: AgentProvider | null; agentLocation?: AgentLocation | null; localAgentCwd?: string | null; openCodeAdditionalDirectories?: string[]; modelSource?: AgentModelSource | null; modelId?: string | null; codexBackend?: CodexBackend | null; codexModel?: string | null; codexExperimentalAcknowledged?: boolean | null; graphicalSessionEnabled?: boolean; sshConfig?: SshConfig; quickCommands?: QuickCommand[]; tags?: string[] }) => Promise<TerminalSession[]>;
  switchAgent: (id: string, provider: AgentProvider) => Promise<TerminalSession>;
  switchModelSource: (id: string, source: AgentModelSource, restart?: boolean, modelId?: string) => Promise<TerminalSession>;
  closeSession: (id: string) => Promise<TerminalSession[]>;
  reconnectSession: (id: string) => Promise<TerminalSession>;
  getHistory: (id: string) => Promise<string>;
  getHistorySnapshot: (id: string) => Promise<{ data: string; seq: number }>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  claimSize: (id: string, cols: number, rows: number) => void;
  onData: (callback: (payload: { id: string; seq: number; data: string }) => void) => () => void;
  onExit: (callback: (payload: { id: string; exitCode: number }) => void) => () => void;
  onSizeOwner: (callback: (payload: { sessionId: string; owner: string; cols: number; rows: number }) => void) => () => void;
  onAgentStatus: (callback: (payload: AgentStatusPayload) => void) => () => void;
  onAgentHookDebug: (callback: (payload: AgentHookDebugPayload) => void) => () => void;
  onSessionsChanged: (callback: (sessions: TerminalSession[]) => void) => () => void;
  onSessionSelectRequested: (callback: (payload: { id: string }) => void) => () => void;
  listWslDistros: () => Promise<string[]>;
  loadSavedSessions: () => Promise<TerminalSession[]>;
  getIgnoredConfigWarnings: (templateId: string) => Promise<string[]>;
  ignoreConfigWarning: (templateId: string, fingerprint: string) => Promise<string[]>;
  onConfigWarningsChanged: (callback: (payload: { templateId: string; ignored: string[] }) => void) => () => void;
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
  onGraphicalMenuConfigChanged: (callback: (config: import("./utils/graphicalMenu").GraphicalMenuConfig) => void) => () => void;
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
  onChanged: (callback: (payload: { sessionId: string; paths: string[]; changedFiles: string[] }) => void) => () => void;
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

export type SkillDetail = SkillSummary & { content: string };

export type SkillsApi = {
  read: (provider: SkillProvider, id: string, sessionId?: string) => Promise<SkillDetail>;
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
  searchWorkspaceEntries: (sessionId: string, query: string, rootPath?: string, options?: ProjectSearchOptions, requestId?: string) => Promise<WorkspaceEntrySearchResponse>;
  listDirectories: (sessionId: string, rootPath: string) => Promise<{
    workspaceRoot: string;
    path: string;
    directories: Array<{ name: string; path: string }>;
  }>;
  searchFiles: (sessionId: string, query: string, rootPath: string, options?: ProjectSearchOptions, requestId?: string) => Promise<ProjectFileSearchResponse>;
  searchText: (sessionId: string, query: string, requestId: string, rootPath: string, options?: ProjectSearchOptions) => Promise<ProjectTextSearchResponse>;
  cancelFileSearch: (sessionId: string, requestId: string) => Promise<boolean>;
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
    projectToolsApi: { list: () => Promise<ProjectTool[]> };
    desktopMascotApi?: DesktopMascotApi;
    codexPluginApi: CodexPluginApi;
    codeBuddyPluginApi: CodeBuddyPluginApi;
    codeBuddyMcpApi: CodeBuddyMcpApi;
    codexAppServerApi: CodexAppServerApi;
    codexVersionApi: CodexVersionApi;
    codeBuddyVersionApi: CodeBuddyVersionApi;
    openCodeVersionApi: OpenCodeVersionApi;
    openCodeAuthApi: OpenCodeAuthApi;
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
    sessionApi: SessionApi;
    moduleOwnerApi: ModuleOwnerApi;
    workItemApi: WorkItemApi;
    agentUsageApi: AgentUsageApi;
    workBuddyCheckinApi: WorkBuddyCheckinApi;
    qoderCheckinApi: QoderCheckinApi;
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

export interface CodeBuddyScheduledTaskInput { cron: string; prompt: string; recurring: boolean; durable: boolean }
export interface CodeBuddyScheduledTask extends CodeBuddyScheduledTaskInput { id: string; enabled: boolean; createdAt?: number; lastFiredAt?: number }

export type DesktopMascotOperation =
  | { type: "execute" | "dismiss" | "cancel" | "openUrl" }
  | { type: "approve"; decision: boolean | string }
  | { type: "answer"; answers: Record<string, CodexQuestionAnswer> }
  | { type: "respond"; action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };
export type DesktopMascotPendingAction =
  | { kind: "plan"; requestId: string; key: string; text: string }
  | { kind: "approval"; requestId: number | string; key: string; request: CodexAppServerSnapshot["approvals"][number]; items: CodexAppServerSnapshot["items"] }
  | { kind: "question"; requestId: number | string; key: string; request: CodexQuestionRequest }
  | { kind: "elicitation"; requestId: number | string; key: string; request: CodexMcpElicitation };
export type DesktopMascotNotification = { id: string; sessionId: string; sessionTitle: string; status: "completed" | "failed" | "pending"; agentStatus?: AgentStatusPayload; action?: DesktopMascotPendingAction; summary: string; timestamp: number };
export type DesktopMascotNotifications = { revision: number; notification: DesktopMascotNotification | null; pendingCount: number };
export type DesktopMascotState = { collapsed: boolean; animated: boolean; moving: boolean; roaming: boolean; roamingDirection: "left" | "right"; migrated: boolean; locale: Locale; notifications: DesktopMascotNotifications };
export interface DesktopMascotApi {
  getState(): Promise<DesktopMascotState>;
  onState(callback: (state: DesktopMascotState) => void): () => void;
  onNotifications(callback: (snapshot: DesktopMascotNotifications) => void): () => void;
  processNotification(id: string, operation: DesktopMascotOperation): Promise<void>;
  dismissNotification(id: string): void;
  setNotificationPresentation(id: string, paused: boolean): void;
  setNotificationExpanded(id: string, expanded: boolean): void;
  setSummaryExpanded(id: string, expanded: boolean): void;
  setPreferences(preferences: Partial<Pick<DesktopMascotState, "collapsed" | "moving">>): void;
  migrate(preferences: { collapsed: boolean; animated: boolean }): void;
  setInteraction(paused: boolean, reduced: boolean): void;
  setRegions(regions: { x: number; y: number; width: number; height: number }[]): void;
  startDrag(): void;
  endDrag(): void;
  step(direction: "left" | "right" | "up" | "down"): void;
}

export type SessionApiState = { enabled: boolean; running: boolean; port: number; url: string; lanUrls: string[]; error: string };
export type WorkItemStatus = "pending" | "creating" | "running" | "uncertain" | "completed" | "failed" | "stopped" | "void";
export type WorkItem = { id: string; sourceRunId: string; taskId: string; ownerId: string; templateId: string; taskName: string;
  output: string; owner: ModuleOwnerRecord; template: { title: string; cwd: string }; tools: string[];
  needsFollowUp: boolean; status: WorkItemStatus; version: number; createdAt: number; updatedAt: number; latestAttemptId?: string; lastStartedAt?: number;
  sessionId?: string; sourceSessionId?: string; sourceThreadId?: string; sourceTurnId?: string; error?: string; voidReason?: string; voidedAt?: number | null; unavailable: string };
export type WorkItemSummary = Omit<WorkItem, "output"> & { summary: string };
export type WorkItemAttempt = { id: string; workItemId: string; status: WorkItemStatus; startedAt: number; endedAt?: number;
  sessionId?: string; threadId?: string; turnId?: string; input: { prompt: string; [key: string]: unknown }; configuration: Record<string, unknown>; output: string; error: string };
export type WorkItemIdentity = { id: string; version: number };
export type WorkItemPage = { records: WorkItemSummary[]; total: number; storageErrors?: string[]; templates: { id: string; name: string }[]; owners: { id: string; name: string; templateId: string }[] };
export type WorkItemQuickPrompt = { id: string; version: number; name: string; prompt: string; persistent?: boolean };
export type WorkItemQuickPromptMutation = { operation: "add"; name: string; prompt: string; persistent?: boolean } | ({ operation: "update" } & WorkItemQuickPrompt) | { operation: "delete"; id: string; version: number };
export interface WorkItemApi {
  listQuickPrompts(): Promise<WorkItemQuickPrompt[]>;
  mutateQuickPrompt(input: WorkItemQuickPromptMutation): Promise<WorkItemQuickPrompt[]>;
  list(input?: { templateId?: string; ownerId?: string; status?: WorkItemStatus; statuses?: WorkItemStatus[]; needsFollowUp?: boolean; keyword?: string; page?: number }): Promise<WorkItemPage>;
  get(input: { id: string }): Promise<WorkItem>;
  preview(input: WorkItemIdentity & { prompt?: string }): Promise<{ body: { prompt: string; tools?: { name: string }[] }; configuration: Record<string, unknown> }>;
  execute(input: WorkItemIdentity & { prompt?: string }): Promise<WorkItem>;
  markCompleted(input: WorkItemIdentity): Promise<WorkItem>;
  setFollowUp(input: WorkItemIdentity & { needsFollowUp: boolean }): Promise<WorkItem>;
  listAttempts(input: { id: string; page?: number }): Promise<{ records: Omit<WorkItemAttempt, "input" | "output" | "configuration">[]; total: number }>;
  getAttempt(input: { id: string; attemptId: string }): Promise<WorkItemAttempt>;
  void(input: WorkItemIdentity & { reason?: string }): Promise<WorkItem>;
  restore(input: WorkItemIdentity): Promise<WorkItem>;
  resolveUncertain(input: WorkItemIdentity): Promise<WorkItem>;
  onChanged(callback: () => void): () => void;
}
export type ModuleOwnerFields = { name: string; responsibilities: string; directories: string[]; recentActivity?: string };
export type ModuleOwnerRecord = ModuleOwnerFields & { id: string; version: number; createdAt: number; updatedAt: number };
export type ModuleOwnerSettings = { mode: "plan" | "default"; prompt: string };
type ModuleOwnerHistoryMetadata = { id: string; revision: number; operation: string; source: string; sessionId?: string; at: number };
export type ModuleOwnerHistory = ModuleOwnerHistoryMetadata & (
  { kind: "owner"; ownerId: string; before: ModuleOwnerRecord | null; after: ModuleOwnerRecord | null } |
  { kind?: undefined; records: ModuleOwnerRecord[] }
);
export type ModuleOwnerState = { revision: number; records: ModuleOwnerRecord[]; history: ModuleOwnerHistory[]; settings: ModuleOwnerSettings;
  generation: { status: string; sessionId?: string; error: string; startedAt: number } | null };
export type ModuleOwnerTemplate = { templateId: string; title: string; cwd: string; supported: boolean };
export type ModuleOwnerMutation = ({ operation: "add" } & ModuleOwnerFields) | ({ operation: "update"; id: string; version: number } & ModuleOwnerFields) | { operation: "delete"; id: string; version: number };
export type ModuleOwnerTaskRun = { id: string; templateId: string; ownerId: string; taskId: string; taskName: string;
  calledAt: number; endedAt?: number; status: string; sessionId?: string; threadId?: string; turnId?: string;
  error: string; input: unknown; output: string };
export type ModuleOwnerPromptTemplate = { id: string; name: string; prompt: string; version: number; createdAt: number; updatedAt: number; referenceCount: number };
export type ModuleOwnerPromptPublish = { source: Omit<ModuleOwnerPromptTemplate, "referenceCount">; tasks: { templateId: string; templateTitle: string; ownerName: string; taskId: string; taskName: string; prompt: string; fingerprint: string; modified: boolean; appliedVersion?: number; needsUpdate: boolean }[] };
export type ModuleOwnerTaskInput = { promptTemplateId?: string; id?: string; ownerId: string; name: string; prompt: string; mode: "default" | "plan"; enabled: boolean; recordHistory?: boolean; autoCreateWorkItem?: boolean;
  tools: ("list_module_owners" | "update_module_owner")[];
  schedule: { kind: "cron"; cron: string } | { kind: "interval"; minutes: number; count: number } };
export type ModuleOwnerTask = ModuleOwnerTaskInput & { id: string; promptTemplateVersion?: number; promptTemplateSnapshot?: string; executedCount: number; nextRunAt: number | null; lastRun?: { status: string; sessionId?: string; error: string; startedAt: number } };
export interface ModuleOwnerApi {
  listPromptTemplates(): Promise<ModuleOwnerPromptTemplate[]>;
  savePromptTemplate(input: { id?: string; version?: number; name: string; prompt: string }): Promise<ModuleOwnerPromptTemplate[]>;
  deletePromptTemplate(input: { id: string; version: number }): Promise<ModuleOwnerPromptTemplate[]>;
  previewPromptPublish(input: { id: string; version: number }): Promise<ModuleOwnerPromptPublish>;
  publishPromptTemplate(input: { id: string; version: number; targets: { templateId: string; taskId: string; fingerprint: string }[] }): Promise<{ updatedCount: number }>;

  listTaskRuns(id: string, input: { taskId: string; page?: number }): Promise<{ records: Omit<ModuleOwnerTaskRun, "input" | "output">[]; total: number }>;
  getTaskRun(id: string, input: { taskId: string; id: string }): Promise<ModuleOwnerTaskRun>;
  deleteTaskRun(id: string, input: { taskId: string; id: string }): Promise<void>;
  listHistory(id: string, input: { ownerId: string }): Promise<{ revision: number; history: ModuleOwnerHistory[] }>;
  listTasks(id: string): Promise<ModuleOwnerTask[]>;
  runTask(id: string, input: { id: string }): Promise<ModuleOwnerTask[]>;
  copyTask(id: string, input: { taskId: string; targetOwnerIds: string[]; enabled?: boolean }): Promise<ModuleOwnerTask[]>;
  saveTask(id: string, input: ModuleOwnerTaskInput): Promise<ModuleOwnerTask[]>;
  deleteTask(id: string, input: { id: string }): Promise<ModuleOwnerTask[]>;
  listTemplates(): Promise<ModuleOwnerTemplate[]>;
  get(id: string): Promise<ModuleOwnerState>;
  getGeneration(id: string): Promise<ModuleOwnerState["generation"]>;
  preview(id: string, input: ModuleOwnerSettings): Promise<unknown>;
  generate(id: string, input: ModuleOwnerSettings): Promise<{ result: SessionApiResult; state: ModuleOwnerState; request?: unknown }>;
  mutate(id: string, input: ModuleOwnerMutation): Promise<ModuleOwnerState>;
  configure(id: string, input: ModuleOwnerSettings): Promise<ModuleOwnerState>;
  restore(id: string, input: { historyId: string; revision: number }): Promise<ModuleOwnerState>;
  onChanged(callback: (event: { templateId: string }) => void): () => void;
}
export type SessionApiResult = { method: string; url: string; status: number; elapsedMs: number; body: unknown };
export type SessionApiTemplate = { templateId: string; title: string; agentProvider: string; type: string; graphicalSessionEnabled: boolean; modelSource: string; modelId: string | null };
export interface SessionApi {
  get(): Promise<SessionApiState>;
  configure(input: { enabled?: boolean; port?: number }): Promise<SessionApiState>;
  revealToken(): Promise<string>;
  resetToken(): Promise<string>;
  invoke(input: { operation: "list" | "create" | "listInstances" | "getInstanceStatus"; sessionId?: string; body?: unknown }): Promise<SessionApiResult>;
  onChanged(callback: (state: SessionApiState) => void): () => void;
}
