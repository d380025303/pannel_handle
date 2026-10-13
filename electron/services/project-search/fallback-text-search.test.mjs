import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { runFallbackTextSearch } from "./fallback-text-search.cjs";
import { createRipgrepInvocation, runRipgrepSearch } from "./ripgrep-search.cjs";

describe("WSL fallback text search", () => {
  it("includes ignored and excluded-directory files only when requested, while excluding VCS metadata", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-wsl-fallback-"));
    const query = "unique-fallback-search-marker";
    try {
      execFileSync("git", ["init", "--quiet", dir]);
      fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\ndist/\n");
      for (const relativePath of ["normal.txt", "ignored.txt", "dist/hit.txt", "dist/tracked.txt", ".git/search-marker.txt", ".hg/search-marker.txt", ".svn/search-marker.txt"]) {
        const filePath = path.join(dir, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, query);
      }
      execFileSync("git", ["-C", dir, "add", "--force", "normal.txt", "dist/tracked.txt"]);
      const spawnProcess = vi.fn((command, args, options) => {
        expect(command).toBe("wsl.exe");
        expect(args.slice(0, 6)).toEqual(["-d", "test-distro", "--cd", "/project", "--exec", "git"]);
        return spawn("git", ["-C", dir, ...args.slice(6)], options);
      });
      const search = (includeIgnored) => runFallbackTextSearch({
        fsApi: fs,
        spawnProcess,
        session: { type: "wsl", wslDistro: "test-distro" },
        query,
        root: { hostRoot: dir, displayRoot: "/project" },
        task: { cancelled: false, child: null },
        options: { includeIgnored }
      });

      const filtered = await search(false);
      expect(filtered.engine).toBe("fallback");
      expect(filtered.results.map((entry) => entry.relativePath)).toEqual(["normal.txt"]);
      expect(spawnProcess).toHaveBeenCalledTimes(1);

      const inclusive = await search(true);
      expect(inclusive.results.map((entry) => entry.relativePath).sort())
        .toEqual(["dist/hit.txt", "dist/tracked.txt", "ignored.txt", "normal.txt"]);
      expect(inclusive.results.map((entry) => entry.path).sort())
        .toEqual(["/project/dist/hit.txt", "/project/dist/tracked.txt", "/project/ignored.txt", "/project/normal.txt"]);
      expect(spawnProcess).toHaveBeenCalledTimes(1);

      // Run the bundled binary against the same files to compare filtering semantics.
      for (const [includeIgnored, fallback] of [[false, filtered], [true, inclusive]]) {
        const session = { type: "windows" };
        const invocation = await createRipgrepInvocation(session, query, undefined, dir, { includeIgnored });
        const results = await runRipgrepSearch({
          spawnProcess: spawn,
          invocation,
          session,
          displayRoot: dir,
          task: { cancelled: false, child: null }
        });
        const comparable = (entries) => entries.map(({ relativePath, lineNumber, line, matchStart, matchLength }) => ({
          relativePath: relativePath.replace(/\\/g, "/"), lineNumber, line, matchStart, matchLength
        })).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        expect(comparable(results)).toEqual(comparable(fallback.results));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
