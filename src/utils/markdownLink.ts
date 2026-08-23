export type MarkdownLinkTarget =
  | { kind: "external"; url: string }
  | { kind: "file"; path: string }
  | { kind: "ignore" };

function decodeLinkPath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizePath(value: string, windowsPath: boolean, separator: "/" | "\\") {
  const normalized = value.replace(/\\/g, "/");
  const drive = windowsPath ? normalized.match(/^([a-zA-Z]:)(?:\/|$)/)?.[1] : undefined;
  const absolute = Boolean(drive) || normalized.startsWith("/");
  const pathWithoutRoot = drive
    ? normalized.slice(drive.length).replace(/^\/+/, "")
    : normalized.replace(/^\/+/, "");
  const segments: string[] = [];

  for (const segment of pathWithoutRoot.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  const joined = segments.join(separator);
  if (drive) return joined ? `${drive}${separator}${joined}` : `${drive}${separator}`;
  if (absolute) return `${separator}${joined}` || separator;
  return joined || ".";
}

function resolveFilePath(sourcePath: string, targetPath: string) {
  const windowsPath = /^[a-zA-Z]:[\\/]/.test(sourcePath) || sourcePath.includes("\\");
  const separator: "/" | "\\" = windowsPath && sourcePath.includes("\\") ? "\\" : "/";
  const normalizedTarget = targetPath.replace(/\\/g, "/");
  const sourceDrive = windowsPath ? sourcePath.replace(/\\/g, "/").match(/^([a-zA-Z]:)/)?.[1] : undefined;
  const absoluteTarget = /^[a-zA-Z]:\//.test(normalizedTarget) || normalizedTarget.startsWith("/");
  const rootedTarget = windowsPath && normalizedTarget.startsWith("/") && sourceDrive
    ? `${sourceDrive}${normalizedTarget}`
    : normalizedTarget;

  if (absoluteTarget) {
    return normalizePath(rootedTarget, windowsPath, separator);
  }

  const normalizedSource = sourcePath.replace(/\\/g, "/");
  const separatorIndex = normalizedSource.lastIndexOf("/");
  const parentPath = separatorIndex === -1 ? "." : normalizedSource.slice(0, separatorIndex) || "/";
  return normalizePath(`${parentPath}/${normalizedTarget}`, windowsPath, separator);
}

function fileUrlPath(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const hostPrefix = url.hostname && url.hostname !== "localhost" ? `//${url.hostname}` : "";
    const pathname = decodeLinkPath(url.pathname);
    return `${hostPrefix}${pathname}`.replace(/^\/([a-zA-Z]:\/)/, "$1");
  } catch {
    return null;
  }
}

export function resolveMarkdownLink(sourcePath: string, href: string): MarkdownLinkTarget {
  const value = href.trim();
  if (!value || value.startsWith("#")) return { kind: "ignore" };
  if (/^https?:\/\//i.test(value)) return { kind: "external", url: value };

  let targetPath = value;
  if (/^file:/i.test(value)) {
    const parsedPath = fileUrlPath(value);
    if (!parsedPath) return { kind: "ignore" };
    targetPath = parsedPath;
  } else if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) && !/^[a-zA-Z]:[\\/]/.test(value)) {
    return { kind: "ignore" };
  } else {
    targetPath = value.split(/[?#]/, 1)[0];
  }

  targetPath = decodeLinkPath(targetPath);
  if (!targetPath) return { kind: "ignore" };
  return { kind: "file", path: resolveFilePath(sourcePath, targetPath) };
}
