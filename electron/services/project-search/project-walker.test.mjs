import { describe, expect, it } from "vitest";
import path from "node:path";
import { walkProject } from "./project-walker.cjs";

const directory = (name) => ({ name, isDirectory: () => true, isFile: () => false });
const file = (name) => ({ name, isDirectory: () => false, isFile: () => true });

function fixture() {
  const reads = [];
  const files = [];
  const directories = [];
  const tree = { "": [directory("a"), directory("b"), file("root.txt")], a: [directory("nested"), file("a.txt")], b: [file("b.txt")], [path.join("a", "nested")]: [file("deep.txt")] };
  return {
    reads, files, directories,
    options: {
      hostRoot: path.resolve("walker-fixture"),
      fsApi: { promises: { readdir: async (hostPath) => {
        const relative = path.relative(path.resolve("walker-fixture"), hostPath);
        reads.push(relative);
        return tree[relative];
      } } },
      onFile: async ({ relativePath }) => { files.push(relativePath); },
      onDirectory: async ({ relativePath }) => { directories.push(relativePath); },
      maxVisitedEntries: 100000,
      task: { cancelled: false }
    }
  };
}

describe("walkProject queue", () => {
  it("preserves breadth-first directory and file order", async () => {
    const { options, reads, files, directories } = fixture();
    await walkProject(options);
    expect(reads).toEqual(["", "a", "b", path.join("a", "nested")]);
    expect(directories).toEqual(["a", "b", path.join("a", "nested")]);
    expect(files).toEqual(["root.txt", path.join("a", "a.txt"), path.join("b", "b.txt"), path.join("a", "nested", "deep.txt")]);
  });

  it("stops at the file result limit with queued directories remaining", async () => {
    const { options, reads, files } = fixture();
    await walkProject({ ...options, maxResults: () => files.length >= 2 });
    expect(files).toHaveLength(2);
    expect(reads).toEqual(["", "a"]);
  });

  it("stops at the directory result limit", async () => {
    const { options, reads, directories, files } = fixture();
    await walkProject({ ...options, maxResults: () => directories.length >= 2 });
    expect(directories).toEqual(["a", "b"]);
    expect(files).toEqual([]);
    expect(reads).toEqual([""]);
  });

  it("keeps the visited-entry limit", async () => {
    const { options, reads, files, directories } = fixture();
    await walkProject({ ...options, maxVisitedEntries: 4 });
    expect(reads).toEqual(["", "a"]);
    expect(files).toEqual(["root.txt"]);
    expect(directories).toEqual(["a", "b", path.join("a", "nested")]);
  });

  it("cancels before reading another queued directory", async () => {
    const { options, reads } = fixture();
    options.onFile = async () => { options.task.cancelled = true; };
    await expect(walkProject(options)).rejects.toMatchObject({ code: "SEARCH_CANCELLED" });
    expect(reads).toEqual([""]);
  });

  it("cancels before the first read", async () => {
    const { options, reads } = fixture();
    options.task.cancelled = true;
    await expect(walkProject(options)).rejects.toMatchObject({ code: "SEARCH_CANCELLED" });
    expect(reads).toEqual([]);
  });
});
