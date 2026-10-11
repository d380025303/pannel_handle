import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { detectImpact } = require("./change-detector.cjs");
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inspector-impact-")); roots.push(root);
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  git(["init"]); git(["config", "user.name", "Inspector"]); git(["config", "user.email", "inspector@example.invalid"]);
  function write(file, content) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); }
  write("src/shared.js", "export const value = 1;\n");
  write("src/ui.js", "import { value } from './shared'; export { value };\n");
  write("mobile/use.js", "import { value } from '../src/ui.js'; export { value };\n");
  write("other/independent.js", "export const other = 1;\n");
  git(["add", "."]); git(["commit", "-m", "baseline"]);
  const base = git(["rev-parse", "HEAD"]).trim();
  const commit = () => { git(["add", "-A"]); git(["commit", "-m", "change"]); return git(["rev-parse", "HEAD"]).trim(); };
  return { root, git, write, base, commit };
}
it("follows transitive imports across role boundaries without including unrelated modules", async () => {
  const f = fixture(); f.write("src/shared.js", "export const value = 2;\n"); const head = f.commit();
  expect(await detectImpact({ root: f.root, base: f.base, head })).toMatchObject({ full: false, paths: ["mobile/use.js", "src/shared.js", "src/ui.js"] });
});
it("keeps consumers of deleted modules in the impact scope", async () => {
  const f = fixture(); fs.unlinkSync(path.join(f.root, "src/shared.js")); const head = f.commit();
  expect((await detectImpact({ root: f.root, base: f.base, head })).paths).toContain("mobile/use.js");
});
it("uses a full review for shared package/config changes and dynamic dependencies", async () => {
  const f = fixture(); f.write("package.json", "{}"); const head = f.commit();
  expect((await detectImpact({ root: f.root, base: f.base, head })).full).toBe(true);
  f.write("other/independent.js", "module.exports = require(moduleName);\n"); const second = f.commit();
  expect(await detectImpact({ root: f.root, base: head, head: second })).toMatchObject({ full: true, reason: "dynamic-module-reference" });
});
it("returns an empty scope for unchanged commits and a full scope when graph budgets are exceeded", async () => {
  const f = fixture(); expect((await detectImpact({ root: f.root, base: f.base, head: f.base })).paths).toEqual([]);
  f.write("src/shared.js", "export const value = 3;\n"); const head = f.commit();
  expect(await detectImpact({ root: f.root, base: f.base, head, maxBytes: 4 })).toMatchObject({ full: true, reason: "dependency-byte-limit" });
});
