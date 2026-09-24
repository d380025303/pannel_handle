import { resolveMarkdownLink } from "./markdownLink";
import { isPathInside } from "./remoteFileTree";

export type CodexFileLinkTarget =
  | { kind: "external"; url: string }
  | { kind: "file"; path: string; line?: number }
  | { kind: "ignore" }
  | { kind: "error"; message: string };

export function resolveCodexFileLink(cwd: string, href: string): CodexFileLinkTarget {
  const value = href.trim();
  if (!value || value.startsWith("#")) return { kind: "ignore" };
  if (/^https?:\/\//i.test(value)) return { kind: "external", url: value };

  const fragmentLine = value.match(/#L(\d+)(?:C\d+)?$/i);
  const withoutFragment = fragmentLine ? value.slice(0, fragmentLine.index) : value;
  const suffixLine = !fragmentLine && !/^file:/i.test(withoutFragment)
    ? withoutFragment.match(/:(\d+)(?::\d+)?$/) : null;
  const link = suffixLine ? withoutFragment.slice(0, suffixLine.index) : withoutFragment;
  const lineValue = fragmentLine?.[1] ?? suffixLine?.[1];
  const line = lineValue === undefined ? undefined : Number(lineValue);
  if (lineValue !== undefined && (!Number.isSafeInteger(line) || line! < 1)) {
    return { kind: "error", message: "文件链接中的行号无效。" };
  }

  const source = `${cwd.replace(/[\\/]$/, "")}/__codex_link__.md`;
  const target = resolveMarkdownLink(source, link);
  if (target.kind !== "file") return target;
  if (!isPathInside(target.path, cwd)) {
    return { kind: "error", message: "只能跳转到当前工作目录内的文件。" };
  }
  return { kind: "file", path: target.path, ...(line === undefined ? {} : { line }) };
}
