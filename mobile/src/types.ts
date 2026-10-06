import type { CodexAppServerSnapshot, CodexCapabilityReference } from "../../src/vite-env";
export const PROTOCOL_VERSION = 8 as const;
export type RuntimeMode = "terminal" | "app-server";
export type AgentProvider = "codex" | "codebuddy" | "opencode" | "claude" | "qoder" | "gemini" | "grok";

export type TerminalKind = "windows" | "wsl" | "ssh";
export type QuickCommand = { id: string; command: string; mode?: "write" | "auto-enter" | "one-time"; pinned?: boolean };

export type RuntimeSession = {
  id: string;
  templateId?: string;
  title: string;
  type: TerminalKind;
  runtimeMode: RuntimeMode;
  agentProvider?: AgentProvider;
  cwd?: string;
  sshConnectionState?: "connecting" | "connected" | "reconnecting" | "disconnected";
  quickCommands?: QuickCommand[];
  tags?: string[];
};

export type SavedTemplate = {
  id: string;
  title: string;
  type: TerminalKind;
  runtimeMode: RuntimeMode;
  agentProvider?: AgentProvider;
  cwd?: string;
  wslDistro?: string;
  sshEndpoint?: string;
  tags?: string[];
  runningCount: number;
};

export type SizeOwner = "desktop" | string;

export type TerminalSnapshot = {
  sessionId: string;
  ansi: string;
  seq: number;
  cols: number;
  rows: number;
  owner: SizeOwner;
};

export type ReadyPayload = {
  deviceId: string;
  deviceName: string;
  sessions: RuntimeSession[];
  templates: SavedTemplate[];
};
export type SessionOverview = { sessionId: string; status: "运行中" | "空闲" | "处理中" | "待确认" | "连接中" | "重连中" | "已断开" | "错误"; detail?: string; summary: string };

export type ComputerFileEntry = { name: string; path: string; type: "drive" | "directory" | "file"; size: number | null };

export type GraphicalItem = { rewindMessageId?: string; mcpApp?: { serverName: string; resourceUri: string; revision?: number }; id: string; type: string; turnId?: string; text?: string; command?: string;
  summary?: Array<string | { text?: string }>; senderThreadId?: string; receiverThreadId?: string; prompt?: string; agentStatus?: string;
  output?: string; status?: string; toolName?: string; toolKind?: string; explanation?: string;
  tool?: string; server?: string; query?: string; arguments?: unknown; result?: unknown;
  changes?: unknown; toolContent?: unknown[]; locations?: Array<{ path?: string; uri?: string; line?: number }>;
  attachments?: Array<{ name: string; path?: string }>;
  plan?: Array<{ step: string; status: string }>;
  questions?: Array<{ id: string; header: string; question: string; answers: string[] }> };
export type GraphicalApproval = { requestId: number | string; method: string; params: {
  itemId?: string; reason?: string; command?: string; cwd?: string; changes?: unknown;
  permissions?: { network?: unknown; fileSystem?: unknown }; grantRoot?: string; availableDecisions?: Array<string | { acceptWithExecpolicyAmendment?: unknown }>; proposedExecpolicyAmendment?: string[] | null;
  networkApprovalContext?: { host?: string; protocol?: string; port?: number };
  choices?: Array<{ id: string; label: string }> } };
export type GraphicalQuestion = { requestId: number | string; submitting: boolean; params: {
  threadId: string; turnId: string; questions: Array<{ id: string; header: string; question: string;
    isOther?: boolean; isSecret?: boolean; multiSelect?: boolean; options?: Array<{ label: string; description: string }> | null }> } };
export type CodexCommand = "version" | "version-update" | "models" | "model-source" | "fast-mode" | "compact" | "review" | "goal.read" | "goal.set" | "goal.clear"
  | "capabilities" | "app-detail" | "plugin-detail" | "plugin-skill" | "mcp-resource" | "mcp-login" | "mcp-reload"
  | "terminals" | "terminal-stop" | "terminals-clean" | "account.read" | "account.login" | "account.cancel" | "account.logout"
  | "history.rename" | "history.pin" | "history.archive" | "history.unarchive" | "history.fork" | "history.initial"
  | "fork-turn" | "attachment-preview" | "workspace-search" | "subagents" | "subagent-view" | "sandbox" | "elicitation"
  | "plugins" | "plugin-install" | "plugin-uninstall" | "marketplace-add" | "marketplace-refresh" | "marketplace-remove"
  | "plugin-config" | "plugin-enable" | "mcp-config" | "mcp-save" | "mcp-remove";
export type CodeBuddyCommand = "attachment-preview" | "version" | "version-update" | "models" | "model-metadata" | "model-source" | "main-agents" | "main-agent" | "multitask" | "context-window" | "effort" | "side-question" | "side-cancel" | "team-message" | "goal.read" | "goal.refresh" | "goal.set" | "goal.clear" | "history.rename" | "rewind" | "tasks" | "task-create" | "task-delete" | "jobs" | "job-context" | "job-history" | "job-dispatch" | "job-resume" | "job-transcript" | "job-action" | "plugins" | "plugin-reload" | "plugin-install" | "plugin-uninstall" | "plugin-enable" | "plugin-disable" | "plugin-update" | "marketplace-add" | "marketplace-refresh" | "marketplace-remove" | "marketplace-auto" | "mcp-config" | "mcp-save" | "mcp-remove" | "mcp-reveal" | "mcp-runtime" | "mcp-restart" | "app-load" | "app-read" | "app-prepare" | "app-resolve" | "app-dispose" | "app-images";
export type GraphicalSnapshot = Pick<CodexAppServerSnapshot, "mainAgent" | "team" | "codeBuddyGoal" | "sideQuestion" | "availableCommands" | "goal" | "goalLoading" | "goalError" | "account" | "windowsSandboxSetup" | "subAgents" | "turnDiffs" | "tokenUsage" | "turnOutputTokens" | "outputTokensPerSecond" | "outputRateAvailable" | "mcpRuntime" | "mcpLogins" | "mcpReload" | "elicitations"> & { threadId: string | null; provider: AgentProvider; busy: boolean; archived: boolean;
  signedOut?: boolean; compacting?: boolean; reviewing?: boolean; sandboxSettingUp?: boolean; mainAgentChanging?: boolean;
  streamId?: string; revision?: number;
  error: string | null; mode: "default" | "plan"; nativeMode: string | null;
  nativeModes?: Array<{ id: string; name?: string; description?: string }>;
  model?: string | null; effectiveModel?: string | null; backend?: string | null;
  models?: Array<{ id: string; displayName: string; fastAvailable?: boolean; defaultReasoningEffort?: string | null; supportedReasoningEfforts?: Array<{ reasoningEffort: string; description: string }> }>;
  effort?: string | null; fastMode?: boolean; executionPermission?: string | null;
  codeBuddyMobile?: boolean; modelSource?: string; serviceModelId?: string | null;
  contextUsage?: { used: number; size: number } | null;
  acpOptions?: Array<{ id: string; type?: string; currentValue?: string | boolean; options: Array<{ value: string; name: string; description?: string }> }>;
  capabilities: { sideQuestion?: boolean; rewind?: boolean; history?: boolean; forkHistory?: boolean; deleteHistory?: boolean; plan?: boolean; permissions?: boolean; supportedPermissions?: Array<"readOnly" | "askApproval" | "fullAccess"> } | null; pendingPlan: { itemId: string } | null;
  items: GraphicalItem[]; diagnostics?: Array<{ id: string; turnId: string | null; at: number;
    message: string; kind: string | null; httpStatusCode: number | null; additionalDetails: unknown }>;
  approvals: GraphicalApproval[]; questions: GraphicalQuestion[] };
export type GraphicalHistory = { data: Array<{ id: string; title: string; updatedAt: number; archived?: boolean; isPinned?: boolean }>;
  nextCursor: string | null };
export type GraphicalUsageLimit = { id: string; name: string; usedPercent: number; remainingPercent: number;
  windowDurationMins?: number; resetsAt?: number; category?: string; totalAmount?: number;
  usedAmount?: number; remainingAmount?: number; total?: number; used?: number; remaining?: number;
  unit?: "Credits"; expiresAt?: number;
  available?: boolean; unlimited?: boolean };
export type GraphicalUsage = { provider: "codex" | "codebuddy" | "minimax" | "qoder" | "gemini"; fetchedAt: number; primaryLimitId: string;
  summary?: { kind: "credits"; total: number; used: number; remaining: number;
    usedPercent: number; remainingPercent: number; unit: "Credits" }
    | { kind: "currency"; currency: "CNY"; available: number; cash: number; voucher: number;
      credit: number; owed: number };
  limits: GraphicalUsageLimit[] };

export type ServerMessage =
  | { v: 8; type: "graphical.result"; requestId: string; sessionId: string; threadId: string | null; result: unknown }
  | { v: 8; type: "ready"; payload: ReadyPayload }
  | { v: 8; type: "session.overview"; overview: SessionOverview }
  | { v: 8; type: "sessions.changed"; sessions: RuntimeSession[] }
  | { v: 8; type: "templates.changed"; templates: SavedTemplate[] }
  | { v: 8; type: "session.launched"; sessionId: string }
  | { v: 8; type: "terminal.snapshot"; snapshot: TerminalSnapshot }
  | { v: 8; type: "terminal.data"; sessionId: string; data: string; seq: number }
  | { v: 8; type: "terminal.exit"; sessionId: string; exitCode?: number }
  | { v: 8; type: "terminal.size-owner"; sessionId: string; owner: SizeOwner; cols: number; rows: number }
  | { v: 8; type: "graphical.snapshot"; sessionId: string; snapshot: GraphicalSnapshot }
  | { v: 8; type: "graphical.delta"; sessionId: string; streamId: string; threadId: string | null;
      baseRevision: number; revision: number; turnDiffs?: CodexAppServerSnapshot["turnDiffs"]; items: GraphicalItem[]; textDeltas: Array<{ itemId: string; delta: string }> }
  | { v: 8; type: "graphical.usage"; sessionId: string; threadId: string | null; requestId: string; usage: GraphicalUsage }
  | { v: 8; type: "graphical.history"; sessionId: string; threadId: string | null; requestId: string; history: GraphicalHistory }
  | { v: 8; type: "graphical.upload.ready"; requestId: string; fileId: string; url: string }
  | { v: 8; type: "files.list.result"; requestId: string; path: string | null; entries: ComputerFileEntry[] }
  | { v: 8; type: "files.download.ready"; requestId: string; url: string }
  | { v: 8; type: "command.ok"; requestId: string; sessionId?: string; threadId?: string | null }
  | { v: 8; type: "pong"; at: number }
  | { v: 8; type: "error"; code: string; message: string; requestId?: string };

export type ClientMessage =
  | { v: 8; type: `graphical.codebuddy.${CodeBuddyCommand}`; sessionId: string; threadId: string | null; requestId: string; input: Record<string, unknown> }
  | { v: 8; type: `graphical.codex.${CodexCommand}`; sessionId: string; threadId: string | null; requestId: string; input?: Record<string, unknown> }
  | { v: 8; type: "password.login"; password: string; deviceName: string }
  | { v: 8; type: "terminal.subscribe"; sessionId: string; lastSeq?: number }
  | { v: 8; type: "terminal.input"; sessionId: string; data: string }
  | { v: 8; type: "quick-command.invoke"; sessionId: string; commandId: string; threadId?: string | null; requestId: string }
  | { v: 8; type: "terminal.claim-size"; sessionId: string; cols: number; rows: number }
  | { v: 8; type: "terminal.resize"; sessionId: string; cols: number; rows: number }
  | { v: 8; type: "template.launch"; templateId: string; cols: number; rows: number; requestId: string }
  | { v: 8; type: "session.rename"; sessionId: string; title: string; requestId: string }
  | { v: 8; type: "session.close"; sessionId: string; requestId: string }
  | { v: 8; type: "session.switch-agent"; sessionId: string; threadId: string | null; provider: AgentProvider; requestId: string }
  | { v: 8; type: "graphical.subscribe"; sessionId: string; delta?: boolean }
  | { v: 8; type: "graphical.usage"; sessionId: string; threadId: string | null; force?: boolean; requestId: string }
  | { v: 8; type: "graphical.submit"; sessionId: string; threadId: string | null; text: string; fileIds?: string[]; references?: CodexCapabilityReference[]; requestId: string }
  | { v: 8; type: "graphical.upload.prepare"; sessionId: string; threadId: string | null; name: string; size: number; requestId: string }
  | { v: 8; type: "graphical.upload.discard"; sessionId: string; threadId: string | null; fileIds: string[]; requestId: string }
  | { v: 8; type: "files.list"; path: string | null; requestId: string }
  | { v: 8; type: "files.download.prepare"; path: string; requestId: string }
  | { v: 8; type: "graphical.effort"; sessionId: string; threadId: string | null; effort: string; requestId: string }
  | { v: 8; type: "graphical.model"; sessionId: string; threadId: string | null; modelId: string; requestId: string }
  | { v: 8; type: "graphical.interrupt" | "graphical.new-thread"; sessionId: string; threadId: string | null; requestId: string }
  | { v: 8; type: "graphical.history"; sessionId: string; threadId: string | null; cursor?: string | null; archived?: boolean; requestId: string }
  | { v: 8; type: "graphical.resume"; sessionId: string; threadId: string | null; targetThreadId: string; requestId: string }
  | { v: 8; type: "graphical.fork"; sessionId: string; threadId: string | null; targetThreadId: string; requestId: string }
  | { v: 8; type: "graphical.delete"; sessionId: string; threadId: string | null; targetThreadId: string; requestId: string }
  | { v: 8; type: "graphical.approval"; sessionId: string; threadId: string | null; approvalId: number | string; decision: boolean | string; requestId: string }
  | { v: 8; type: "graphical.answer"; sessionId: string; threadId: string | null; questionId: number | string;
    answers: Record<string, { answers: string[] }>; requestId: string }
  | { v: 8; type: "graphical.cancelQuestion"; sessionId: string; threadId: string | null; questionId: number | string; requestId: string }
  | { v: 8; type: "graphical.plan"; sessionId: string; threadId: string | null; itemId: string; execute: boolean; requestId: string }
  | { v: 8; type: "graphical.mode"; sessionId: string; threadId: string | null; mode: "default" | "plan"; requestId: string }
  | { v: 8; type: "graphical.permission"; sessionId: string; threadId: string | null; permission: "readOnly" | "askApproval" | "fullAccess"; requestId: string }
  | { v: 8; type: "graphical.native-mode"; sessionId: string; threadId: string | null; modeId: string; requestId: string }
  | { v: 8; type: "ping"; at: number };

export type ConnectionStatus = "connecting" | "password-required" | "connected" | "disconnected" | "error";
