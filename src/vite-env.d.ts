/// <reference types="vite/client" />

export type QuickCommand = {
  id: string;
  label: string;
  command: string;
};

export type SshConfig = {
  host: string;
  username?: string;
  port?: number;
  identityFile?: string;
  remoteCommand?: string;
  extraArgs?: string[];
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
  type: 'windows' | 'wsl' | 'ssh';
  wslDistro?: string;
  sshConfig?: SshConfig;
  quickCommands?: QuickCommand[];
};

export type AgentProvider = "claude" | "codex";

export type AgentRunStatus = "running" | "waiting_for_permission" | "completed" | "failed" | "ended" | "exited";

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
};

export type TerminalApi = {
  listSessions: () => Promise<TerminalSession[]>;
  createSession: (options?: { title?: string; shell?: string; cwd?: string; cols?: number; rows?: number; initialCommand?: string; type?: 'windows' | 'wsl' | 'ssh'; wslDistro?: string; sshConfig?: SshConfig; quickCommands?: QuickCommand[] }) => Promise<TerminalSession>;
  updateSession: (id: string, updates: { title?: string; initialCommand?: string; sshConfig?: SshConfig; quickCommands?: QuickCommand[] }) => Promise<TerminalSession[]>;
  closeSession: (id: string) => Promise<TerminalSession[]>;
  getHistory: (id: string) => Promise<string>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  onData: (callback: (payload: { id: string; data: string }) => void) => () => void;
  onExit: (callback: (payload: { id: string; exitCode: number }) => void) => () => void;
  onAgentStatus: (callback: (payload: AgentStatusPayload) => void) => () => void;
  onSessionsChanged: (callback: (sessions: TerminalSession[]) => void) => () => void;
  listWslDistros: () => Promise<string[]>;
  loadSavedSessions: () => Promise<TerminalSession[]>;
  launchSessions: (sessions: TerminalSession[]) => Promise<TerminalSession[]>;
  deleteSavedSession: (id: string) => Promise<TerminalSession[]>;
  reorderSavedSessions: (orderedIds: string[]) => Promise<TerminalSession[]>;
  reorderRunningSessions: (orderedIds: string[]) => Promise<TerminalSession[]>;
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
};

declare global {
  interface Window {
    terminalApi: TerminalApi;
    clipboardApi: ClipboardApi;
    windowApi: WindowApi;
  }
}
