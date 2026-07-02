import { describe, expect, it } from "vitest";
import type { RemoteFileEntry } from "../vite-env";
import { findLoadedPathChain, flattenLoadedTree, isPathInside, parentTreePath, removeTreeBranch, sameTreePath, type DirectoryTreeState } from "./remoteFileTree";

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

  it("keeps navigation inside POSIX roots", () => {
    expect(isPathInside("/home/me/project", "/home/me/project")).toBe(true);
    expect(isPathInside("/home/me/project/src", "/home/me/project")).toBe(true);
    expect(isPathInside("/home/me/project-old", "/home/me/project")).toBe(false);
    expect(isPathInside("/home/me", "/home/me/project")).toBe(false);
    expect(isPathInside("/tmp", "/")).toBe(true);
    expect(parentTreePath("/home/me/project/src")).toBe("/home/me/project");
    expect(parentTreePath("/")).toBe("/");
  });

  it("keeps navigation inside case-insensitive Windows roots", () => {
    expect(isPathInside("c:/WORK/project", "C:\\work\\project")).toBe(true);
    expect(isPathInside("C:\\work\\project\\src", "c:/work/project")).toBe(true);
    expect(isPathInside("C:\\work\\project-old", "C:\\work\\project")).toBe(false);
    expect(isPathInside("C:\\work", "C:\\work\\project")).toBe(false);
    expect(sameTreePath(parentTreePath("C:\\work\\project"), "C:\\work")).toBe(true);
    expect(parentTreePath("C:\\")).toBe("C:");
  });

  it("removes a cached branch without affecting siblings", () => {
    const next = removeTreeBranch(tree, "/home/src");
    expect(next["/home/src"]).toBeUndefined();
    expect(next["/home"]).toBeDefined();
  });
});

describe("single-subfolder chain collapsing", () => {
  it("collapses a single-subfolder directory into one row", () => {
    const rootEntry = directory("a", "/a");
    const b = directory("b", "/a/b");
    const state: DirectoryTreeState = {
      "/a": { status: "ready", entries: [b] },
    };
    const nodes = flattenLoadedTree(rootEntry, state, new Set(["/a"]));
    expect(nodes).toHaveLength(1);
    expect(nodes[0].entry.path).toBe("/a/b");
    expect(nodes[0].chainPrefix).toBe("a");
    expect(nodes[0].depth).toBe(0);
  });

  it("collapses a multi-level chain", () => {
    const rootEntry = directory("a", "/a");
    const b = directory("b", "/a/b");
    const c = directory("c", "/a/b/c");
    const state: DirectoryTreeState = {
      "/a": { status: "ready", entries: [b] },
      "/a/b": { status: "ready", entries: [c] },
      "/a/b/c": { status: "ready", entries: [file("readme.md", "/a/b/c/readme.md")] },
    };
    const nodes = flattenLoadedTree(rootEntry, state, new Set(["/a", "/a/b", "/a/b/c"]));
    expect(nodes).toHaveLength(2);
    expect(nodes[0].entry.path).toBe("/a/b/c");
    expect(nodes[0].chainPrefix).toBe("a / b");
    expect(nodes[1].entry.name).toBe("readme.md");
  });

  it("does not collapse a directory with files", () => {
    const rootEntry = directory("a", "/a");
    const b = directory("b", "/a/b");
    const state: DirectoryTreeState = {
      "/a": { status: "ready", entries: [b, file("readme.md", "/a/readme.md")] },
    };
    const nodes = flattenLoadedTree(rootEntry, state, new Set(["/a"]));
    expect(nodes).toHaveLength(3);
    expect(nodes[0].chainPrefix).toBeNull();
    expect(nodes[1].chainPrefix).toBeNull();
    expect(nodes[2].chainPrefix).toBeNull();
  });

  it("does not collapse a directory with multiple subdirectories", () => {
    const rootEntry = directory("a", "/a");
    const b = directory("b", "/a/b");
    const c = directory("c", "/a/c");
    const state: DirectoryTreeState = {
      "/a": { status: "ready", entries: [b, c] },
    };
    const nodes = flattenLoadedTree(rootEntry, state, new Set(["/a"]));
    expect(nodes).toHaveLength(3);
    expect(nodes[0].chainPrefix).toBeNull();
  });

  it("collapses a loaded parent even when child is not yet loaded", () => {
    const rootEntry = directory("a", "/a");
    const b = directory("b", "/a/b");
    const state: DirectoryTreeState = {
      "/a": { status: "ready", entries: [b] },
    };
    const nodes = flattenLoadedTree(rootEntry, state, new Set());
    expect(nodes).toHaveLength(1);
    expect(nodes[0].entry.path).toBe("/a/b");
    expect(nodes[0].chainPrefix).toBe("a");
  });

  it("collapses chain in search mode", () => {
    const rootEntry = directory("a", "/a");
    const b = directory("b", "/a/b");
    const c = directory("c", "/a/b/c");
    const state: DirectoryTreeState = {
      "/a": { status: "ready", entries: [b] },
      "/a/b": { status: "ready", entries: [c] },
      "/a/b/c": { status: "ready", entries: [file("target.ts", "/a/b/c/target.ts")] },
    };
    const nodes = flattenLoadedTree(rootEntry, state, new Set(["/a", "/a/b", "/a/b/c"]), "target");
    expect(nodes).toHaveLength(2);
    expect(nodes[0].entry.path).toBe("/a/b/c");
    expect(nodes[0].chainPrefix).toBe("a / b");
  });

  it("does not collapse an empty directory", () => {
    const rootEntry = directory("a", "/a");
    const state: DirectoryTreeState = {
      "/a": { status: "ready", entries: [] },
    };
    const nodes = flattenLoadedTree(rootEntry, state, new Set(["/a"]));
    expect(nodes).toHaveLength(1);
    expect(nodes[0].entry.path).toBe("/a");
    expect(nodes[0].chainPrefix).toBeNull();
  });
});
