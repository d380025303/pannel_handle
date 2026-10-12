import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createGitService } = require("./git-service.cjs");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  ["before.txt", "after.txt"],
  ["before[1].txt", "after[1].txt"]
])("previews staged rename changes using both literal paths for %s", async (oldPath, newPath) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-git-rename-test-"));
  temporaryDirectories.push(directory);
  const git = (...args) => execFileSync("git", args, {
    cwd: directory, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  git("init");
  git("config", "user.name", "Pannel Test");
  git("config", "user.email", "pannel@example.test");
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(directory, oldPath), "first line\nsecond line\nthird line\n");
  // These paths would also match bracket pathspecs without literal protection.
  for (const name of ["before1.txt", "after1.txt", "ordinary.txt"]) {
    fs.writeFileSync(path.join(directory, name), "unrelated base\n");
  }
  git("add", "-A");
  git("commit", "-m", "Base");
  git("mv", oldPath, newPath);
  for (const name of ["before1.txt", "after1.txt", "ordinary.txt"]) {
    fs.writeFileSync(path.join(directory, name), "unrelated changed\n");
  }
  git("add", "-A");

  const session = { id: "rename-test", type: "windows", cwd: directory };
  const service = createGitService({ terminalManager: { getSession: () => session }, sessionStore: {} });
  const target = { sessionId: session.id, cwd: directory };
  const request = { scope: "staged", path: newPath, oldPath, status: "R" };
  const pureRename = await service.getDiff(target, request);
  expect(pureRename.rows).toEqual([]);
  expect(pureRename.truncated).toBe(false);

  fs.writeFileSync(path.join(directory, newPath), "first line\nchanged line\nthird line\n");
  git("add", "-A");
  const modifiedRename = await service.getDiff(target, request);
  expect(modifiedRename.rows.filter((row) => row.type !== "context")).toEqual([
    { type: "modify", oldLineNumber: 2, newLineNumber: 2, oldText: "second line", newText: "changed line" }
  ]);

  const ordinaryDiff = await service.getDiff(target, { scope: "staged", path: "ordinary.txt" });
  expect(ordinaryDiff.rows).toEqual([
    { type: "modify", oldLineNumber: 1, newLineNumber: 1, oldText: "unrelated base", newText: "unrelated changed" }
  ]);
});
