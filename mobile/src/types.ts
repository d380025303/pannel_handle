export const PROTOCOL_VERSION = 2 as const;
export type RuntimeMode = "terminal" | "app-server";
export type AgentProvider = "codex" | "codebuddy" | "opencode";

export type TerminalKind = "windows" | "wsl" | "ssh";

export type RuntimeSession = {
  id: string;
  templateId?: string;
  title: string;
  type: TerminalKind;
  runtimeMode: RuntimeMode;
  agentProvider?: AgentProvider;
  cwd?: string;
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

export type GraphicalItem = { id: string; type: string; turnId?: string; text?: string; command?: string;
  output?: string; status?: string; toolName?: string; toolKind?: string; explanation?: string;
  plan?: Array<{ step: string; status: string }>;
  questions?: Array<{ id: string; header: string; question: string; answers: string[] }> };
export type GraphicalApproval = { requestId: number | string; method: string; params: {
  itemId?: string; reason?: string; command?: string; cwd?: string; changes?: unknown;
  networkApprovalContext?: { host?: string; protocol?: string; port?: number };
  choices?: Array<{ id: string; label: string }> } };
export type GraphicalQuestion = { requestId: number | string; submitting: boolean; params: {
  threadId: string; turnId: string; questions: Array<{ id: string; header: string; question: string;
    isOther?: boolean; isSecret?: boolean; options?: Array<{ label: string; description: string }> | null }> } };
export type GraphicalSnapshot = { threadId: string | null; provider: AgentProvider; busy: boolean; archived: boolean;
  error: string | null; mode: "default" | "plan"; nativeMode: string | null;
  capabilities: { history?: boolean; plan?: boolean } | null; pendingPlan: { itemId: string } | null;
  items: GraphicalItem[]; approvals: GraphicalApproval[]; questions: GraphicalQuestion[] };
export type GraphicalHistory = { data: Array<{ id: string; title: string; updatedAt: number; archived?: boolean }>;
  nextCursor: string | null };

export type ServerMessage =
  | { v: 2; type: "pair.pending"; requestId: string; verificationCode: string }
  | { v: 2; type: "pair.approved"; deviceId: string; deviceName: string; token: string }
  | { v: 2; type: "pair.rejected"; reason: string }
  | { v: 2; type: "ready"; payload: ReadyPayload }
  | { v: 2; type: "sessions.changed"; sessions: RuntimeSession[] }
  | { v: 2; type: "templates.changed"; templates: SavedTemplate[] }
  | { v: 2; type: "session.launched"; sessionId: string }
  | { v: 2; type: "terminal.snapshot"; snapshot: TerminalSnapshot }
  | { v: 2; type: "terminal.data"; sessionId: string; data: string; seq: number }
  | { v: 2; type: "terminal.exit"; sessionId: string; exitCode?: number }
  | { v: 2; type: "terminal.size-owner"; sessionId: string; owner: SizeOwner; cols: number; rows: number }
  | { v: 2; type: "graphical.snapshot"; sessionId: string; snapshot: GraphicalSnapshot }
  | { v: 2; type: "graphical.history"; sessionId: string; threadId: string | null; requestId: string; history: GraphicalHistory }
  | { v: 2; type: "command.ok"; requestId: string }
  | { v: 2; type: "pong"; at: number }
  | { v: 2; type: "error"; code: string; message: string; requestId?: string };

export type ClientMessage =
  | { v: 2; type: "pair.request"; nonce: string; deviceName: string }
  | { v: 2; type: "auth"; deviceId: string; token: string }
  | { v: 2; type: "terminal.subscribe"; sessionId: string; lastSeq?: number }
  | { v: 2; type: "terminal.input"; sessionId: string; data: string }
  | { v: 2; type: "terminal.claim-size"; sessionId: string; cols: number; rows: number }
  | { v: 2; type: "terminal.resize"; sessionId: string; cols: number; rows: number }
  | { v: 2; type: "template.launch"; templateId: string; cols: number; rows: number; requestId: string }
  | { v: 2; type: "session.rename"; sessionId: string; title: string; requestId: string }
  | { v: 2; type: "session.close"; sessionId: string; requestId: string }
  | { v: 2; type: "graphical.subscribe"; sessionId: string }
  | { v: 2; type: "graphical.submit"; sessionId: string; threadId: string | null; text: string; requestId: string }
  | { v: 2; type: "graphical.interrupt" | "graphical.new-thread"; sessionId: string; threadId: string | null; requestId: string }
  | { v: 2; type: "graphical.history"; sessionId: string; threadId: string | null; cursor?: string | null; requestId: string }
  | { v: 2; type: "graphical.resume"; sessionId: string; threadId: string | null; targetThreadId: string; requestId: string }
  | { v: 2; type: "graphical.approval"; sessionId: string; threadId: string | null; approvalId: number | string; decision: boolean | string; requestId: string }
  | { v: 2; type: "graphical.answer"; sessionId: string; threadId: string | null; questionId: number | string;
    answers: Record<string, { answers: string[] }>; requestId: string }
  | { v: 2; type: "graphical.plan"; sessionId: string; threadId: string | null; itemId: string; execute: boolean; requestId: string }
  | { v: 2; type: "ping"; at: number };

export type ConnectionStatus = "connecting" | "pairing" | "waiting-approval" | "connected" | "disconnected" | "error";
