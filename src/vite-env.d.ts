/// <reference types="vite/client" />

export type TerminalSession = {
  id: string;
  title: string;
  shell: string;
  cwd: string;
  createdAt: number;
  initialCommand?: string;
  type: 'windows' | 'wsl';
  wslDistro?: string;
};

export type TerminalApi = {
  listSessions: () => Promise<TerminalSession[]>;
  createSession: (options?: { title?: string; shell?: string; cwd?: string; cols?: number; rows?: number; initialCommand?: string; type?: 'windows' | 'wsl'; wslDistro?: string }) => Promise<TerminalSession>;
  updateSession: (id: string, updates: { title?: string; initialCommand?: string }) => Promise<TerminalSession[]>;
  closeSession: (id: string) => Promise<TerminalSession[]>;
  getHistory: (id: string) => Promise<string>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  onData: (callback: (payload: { id: string; data: string }) => void) => () => void;
  onExit: (callback: (payload: { id: string; exitCode: number }) => void) => () => void;
  onSessionsChanged: (callback: (sessions: TerminalSession[]) => void) => () => void;
  listWslDistros: () => Promise<string[]>;
  loadSavedSessions: () => Promise<TerminalSession[]>;
  launchSessions: (sessions: TerminalSession[]) => Promise<TerminalSession[]>;
  deleteSavedSession: (id: string) => Promise<TerminalSession[]>;
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
};

declare global {
  interface Window {
    terminalApi: TerminalApi;
    clipboardApi: ClipboardApi;
    windowApi: WindowApi;
  }
}
