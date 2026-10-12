import { describe, expect, it } from "vitest";
import { toWslHostPath } from "./wsl-paths.cjs";

describe("toWslHostPath", () => {
  it.each([
    "/mnt/c/../d",
    "/mnt/c/..",
    "/mnt/c/project/../../d",
    "/mnt/c/./../d",
    "/mnt/c/project/../other/../../d",
    "/mnt/C//../d"
  ])("rejects traversal above the drive mount root: %s", (linuxPath) => {
    expect(() => toWslHostPath("Ubuntu", linuxPath)).toThrow("Use a canonical absolute Linux path.");
  });

  it.each([
    ["/mnt/d", "D:\\"],
    ["/mnt/c/project", "C:\\project"],
    ["/mnt/c/project/../other", "C:\\project\\..\\other"],
    ["/mnt/c/project/..", "C:\\project\\.."],
    ["/mnt/c/./project", "C:\\.\\project"],
    ["/home/alice", "\\\\wsl.localhost\\Ubuntu\\home\\alice"]
  ])("converts paths within their mount root: %s", (linuxPath, hostPath) => {
    expect(toWslHostPath("Ubuntu", linuxPath)).toBe(hostPath);
  });
});
