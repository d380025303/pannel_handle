import { describe, expect, it } from "vitest";
import type { RemoteFileEntry } from "../vite-env";
import { findLoadedPathChain, flattenLoadedTree, isPathInside, removeTreeBranch, type DirectoryTreeState } from "./remoteFileTree";

const directory = (name: string, path: string): RemoteFileEntry => ({ name, path, type: "directory", size: 0, modifiedAt: 0 });
const file = (name: string, path: string): RemoteFileEntry => ({ name, path, type: "file", size: 10, modifiedAt: 0 });

const root = directory("home", "/home");
const src = directory("src", "/home/src");
const tree: DirectoryTreeState = {
  "/home": { status: "ready", entries: [src, file("README.md", "/home/README.md")] },
  "/home/src": { status: "ready", entries: [file("App.tsx", "/home/src/App.tsx")] }
};

describe("remote file tree", () => {
  it("flattens only expanded branches", () => {
    expect(flattenLoadedTree(root, tree, new Set(["/home"])).map(({ entry }) => entry.name))
      .toEqual(["home", "src", "README.md"]);
    expect(flattenLoadedTree(root, tree, new Set(["/home", "/home/src"])).map(({ entry }) => entry.name))
      .toEqual(["home", "src", "App.tsx", "README.md"]);
  });

  it("keeps ancestors when filtering loaded nodes", () => {
    expect(flattenLoadedTree(root, tree, new Set(), "app").map(({ entry }) => entry.name))
      .toEqual(["home", "src", "App.tsx"]);
  });

  it("finds a loaded directory chain across path separators", () => {
    expect(isPathInside("C:\\Users\\me\\src", "C:\\Users\\me")).toBe(true);
    expect(isPathInside("/home/me", "/")).toBe(true);
    expect(findLoadedPathChain(root, tree, "/home/src")?.map((entry) => entry.path))
      .toEqual(["/home", "/home/src"]);
  });

  it("removes a cached branch without affecting siblings", () => {
    const next = removeTreeBranch(tree, "/home/src");
    expect(next["/home/src"]).toBeUndefined();
    expect(next["/home"]).toBeDefined();
  });
});
