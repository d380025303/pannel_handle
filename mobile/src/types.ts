export const PROTOCOL_VERSION = 1 as const;

export type TerminalKind = "windows" | "wsl" | "ssh";

export type RuntimeSession = {
  id: string;
  templateId?: string;
  title: string;
  type: TerminalKind;
  cwd?: string;
  tags?: string[];
};

export type SavedTemplate = {
  id: string;
  title: string;
  type: TerminalKind;
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

export type ServerMessage =
  | { v: 1; type: "pair.pending"; requestId: string; verificationCode: string }
  | { v: 1; type: "pair.approved"; deviceId: string; deviceName: string; token: string }
  | { v: 1; type: "pair.rejected"; reason: string }
  | { v: 1; type: "ready"; payload: ReadyPayload }
  | { v: 1; type: "sessions.changed"; sessions: RuntimeSession[] }
  | { v: 1; type: "templates.changed"; templates: SavedTemplate[] }
  | { v: 1; type: "session.launched"; sessionId: string }
  | { v: 1; type: "terminal.snapshot"; snapshot: TerminalSnapshot }
  | { v: 1; type: "terminal.data"; sessionId: string; data: string; seq: number }
  | { v: 1; type: "terminal.exit"; sessionId: string; exitCode?: number }
  | { v: 1; type: "terminal.size-owner"; sessionId: string; owner: SizeOwner; cols: number; rows: number }
  | { v: 1; type: "pong"; at: number }
  | { v: 1; type: "error"; code: string; message: string; requestId?: string };

export type ClientMessage =
  | { v: 1; type: "pair.request"; nonce: string; deviceName: string }
  | { v: 1; type: "auth"; deviceId: string; token: string }
  | { v: 1; type: "terminal.subscribe"; sessionId: string; lastSeq?: number }
  | { v: 1; type: "terminal.input"; sessionId: string; data: string }
  | { v: 1; type: "terminal.claim-size"; sessionId: string; cols: number; rows: number }
  | { v: 1; type: "terminal.resize"; sessionId: string; cols: number; rows: number }
  | { v: 1; type: "template.launch"; templateId: string; cols: number; rows: number; requestId: string }
  | { v: 1; type: "session.rename"; sessionId: string; title: string; requestId: string }
  | { v: 1; type: "session.close"; sessionId: string; requestId: string }
  | { v: 1; type: "ping"; at: number };

export type ConnectionStatus = "connecting" | "pairing" | "waiting-approval" | "connected" | "disconnected" | "error";
