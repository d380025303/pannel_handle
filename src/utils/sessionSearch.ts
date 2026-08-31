import type { TerminalSession } from "../vite-env";

export function matchesSessionSearch(session: TerminalSession, searchQuery: string) {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return true;

  return [
    session.title,
    session.type,
    session.shell,
    session.cwd,
    session.wslDistro,
    session.sshConfig?.host,
    session.sshConfig?.username,
    ...(session.tags ?? [])
  ].some((value) => value?.toLowerCase().includes(query));
}
