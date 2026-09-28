export function getTerminalBackgroundUrl(name: string): string {
  if (!name) return "";
  return `terminal-bg://background/${encodeURIComponent(name)}`;
}
