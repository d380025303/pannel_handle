import type { TerminalSession } from "../vite-env";

export type OpenCodeDirectoryEnvironment = Pick<TerminalSession, "type" | "agentLocation" | "cwd"> & { sshConfig?: Pick<NonNullable<TerminalSession["sshConfig"]>, "remotePlatform"> };

export function openCodeUsesWindowsPaths(session: OpenCodeDirectoryEnvironment) {
  if (session.type === "windows" || session.type === "ssh" && session.agentLocation === "local") return true;
  if (session.type === "wsl") return false;
  if (session.sshConfig?.remotePlatform) return session.sshConfig.remotePlatform === "windows";
  return /^[A-Za-z]:[\\/]/.test(session.cwd) || session.cwd.startsWith("\\\\");
}

export function parseOpenCodeAdditionalDirectories(text: string, session: OpenCodeDirectoryEnvironment): string[] | null {
  const windows = openCodeUsesWindowsPaths(session);
  const directories = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (directories.some(directory => /[\0\r\n*?]/.test(directory) || !(windows
    ? /^[A-Za-z]:[\\/]/.test(directory) || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(directory)
    : directory.startsWith("/")))) return null;
  return directories;
}
