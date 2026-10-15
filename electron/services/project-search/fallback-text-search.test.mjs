import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { runFallbackTextSearch } from "./fallback-text-search.cjs";
import { createRipgrepInvocation, runRipgrepSearch } from "./ripgrep-search.cjs";

describe("WSL fallback text search", () => {
  it.each([false, true])("respects ignore rules and includeIgnored (with .ignore: %s)", async (withIgnore) => {
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
      if (withIgnore) {
        fs.writeFileSync(path.join(dir, ".ignore"), "root-ignored.txt\ntracked-ignored.txt\n*.log\nblocked/\n");
        fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
        fs.writeFileSync(path.join(dir, "nested/.ignore"), "!keep.log\nlocal.txt\n");
        fs.mkdirSync(path.join(dir, "blocked"), { recursive: true });
        fs.writeFileSync(path.join(dir, "blocked/.ignore"), "!hit.txt\n");
        for (const name of ["root-ignored.txt", "tracked-ignored.txt", "drop.log", "nested/drop.log", "nested/keep.log", "nested/local.txt", "nested/normal.txt", "blocked/hit.txt"]) {
          fs.writeFileSync(path.join(dir, name), query);
        }
        execFileSync("git", ["-C", dir, "add", "tracked-ignored.txt"]);
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
      expect(filtered.results.map((entry) => entry.relativePath)).toEqual(withIgnore ? ["nested/keep.log", "nested/normal.txt", "normal.txt"] : ["normal.txt"]);
      expect(spawnProcess).toHaveBeenCalledTimes(2);

      const inclusive = await search(true);
      const inclusivePaths = ["dist/hit.txt", "dist/tracked.txt", "ignored.txt", "normal.txt"];
      if (withIgnore) inclusivePaths.push("root-ignored.txt", "tracked-ignored.txt", "drop.log", "nested/drop.log", "nested/keep.log", "nested/local.txt", "nested/normal.txt", "blocked/hit.txt");
      expect(inclusive.results.map((entry) => entry.relativePath).sort()).toEqual(inclusivePaths.sort());
      expect(inclusive.results.map((entry) => entry.path).sort())
        .toEqual(inclusivePaths.map((name) => `/project/${name}`).sort());
      expect(spawnProcess).toHaveBeenCalledTimes(2);

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
