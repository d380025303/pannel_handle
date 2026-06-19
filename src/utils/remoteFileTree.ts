import type { RemoteFileEntry } from "../vite-env";

export type DirectoryTreeState = Record<string, {
  status: "loading" | "ready" | "error";
  entries: RemoteFileEntry[];
  error?: string;
}>;

export type VisibleTreeNode = {
  entry: RemoteFileEntry;
  depth: number;
  parentPath: string | null;
};

export function normalizeTreePath(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

function isWindowsTreePath(value: string) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.includes("\\");
}

export function sameTreePath(left: string, right: string) {
  const normalizedLeft = normalizeTreePath(left);
  const normalizedRight = normalizeTreePath(right);
  return isWindowsTreePath(left) || isWindowsTreePath(right)
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function isPathInside(path: string, root: string) {
  const windowsPath = isWindowsTreePath(path) || isWindowsTreePath(root);
  const normalizedPath = windowsPath ? normalizeTreePath(path).toLowerCase() : normalizeTreePath(path);
  const normalizedRoot = windowsPath ? normalizeTreePath(root).toLowerCase() : normalizeTreePath(root);
  const descendantPrefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(descendantPrefix);
}

export function flattenLoadedTree(
  root: RemoteFileEntry | null,
  directories: DirectoryTreeState,
  expandedPaths: ReadonlySet<string>,
  searchQuery = ""
) {
  if (!root) return [];
  const query = searchQuery.trim().toLowerCase();

  const visit = (entry: RemoteFileEntry, depth: number, parentPath: string | null): VisibleTreeNode[] => {
    const directory = entry.type === "directory" ? directories[entry.path] : undefined;
    const childNodes = directory?.entries.flatMap((child) => visit(child, depth + 1, entry.path)) ?? [];

    if (query) {
      if (entry.name.toLowerCase().includes(query) || childNodes.length > 0) {
        return [{ entry, depth, parentPath }, ...childNodes];
      }
      return [];
    }

    return [
      { entry, depth, parentPath },
      ...(directory && expandedPaths.has(entry.path) ? childNodes : [])
    ];
  };

  return visit(root, 0, null);
}

export function removeTreeBranch(directories: DirectoryTreeState, path: string) {
  return Object.fromEntries(
    Object.entries(directories).filter(([candidate]) => !isPathInside(candidate, path))
  ) as DirectoryTreeState;
}

export function findLoadedPathChain(root: RemoteFileEntry, directories: DirectoryTreeState, targetPath: string) {
  const chain: RemoteFileEntry[] = [root];
  let current = root;
  while (!sameTreePath(current.path, targetPath)) {
    const next = directories[current.path]?.entries.find(
      (entry) => entry.type === "directory" && isPathInside(targetPath, entry.path)
    );
    if (!next) return null;
    chain.push(next);
    current = next;
  }
  return chain;
}
