const path = require("node:path");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40,64}$/;
const MAX_SOURCE_BYTES = 128 * 1024;

// No shell, hooks, filters, builds, repository scripts or arbitrary Git commands.
async function git(root, args, { signal, maxBuffer = 16 * 1024 * 1024 } = {}) {
  const options = {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer, signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" }
  };
  let filterKeys = "";
  try {
    filterKeys = (await execute("git", ["--no-optional-locks", "config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], { ...options, maxBuffer: 64 * 1024 })).stdout;
  } catch (error) { if (error.code !== 1) throw error; }
  const keys = [...new Set(filterKeys.split(/\r?\n/).filter(Boolean))];
  if (keys.some(key => !/^filter\.[^=\x00-\x1f]+\.(clean|smudge|process|required)$/.test(key))) throw new Error("Git 过滤器配置无法安全解析。");
  const disabledFilters = keys.flatMap(key => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]);
  // Even git status can run clean/process filters. Disable them for every
  // Inspector command rather than trusting apparently read-only subcommands.
  const result = await execute("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=", ...disabledFilters, ...args], options);
  return result.stdout;
}
function createProfiler({ git: executeGit = git, remote = false } = {}) {
  const git = executeGit;
function safePath(file) {
  return typeof file === "string" && file.length > 0 && file.length < 1024 && !file.includes("\\") && !file.includes("\0") && !file.includes(":")
    && !file.startsWith("/") && !file.split("/").some(part => part === ".." || part === ".")
    && !/(^|\/)(?:\.env(?:\..*)?|\.git|node_modules|dist|release|build|coverage|temp|vendor|\.ssh|\.codex|\.agents)(\/|$)/i.test(file)
    && !/(?:\.pem|\.key|\.p12|\.pfx|\.sqlite3?|\.db|(?:credentials|secrets?)\.[^/]+)$/i.test(file);
}
function redact(text) {
  return String(text).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED TOKEN]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["']?)[^\s"'`,;]{8,}/gi, "$1[REDACTED]");
}
async function resolveProject(input) {
  if (typeof input !== "string" || !input.trim() || input.length > 4096 || !(remote ? input.startsWith("/") : path.isAbsolute(input)) || input.startsWith("\\\\")) throw new Error("请选择本地 Git 项目的绝对路径。");
  const directory = remote ? input : await fs.realpath(input);
  if (!remote && !(await fs.stat(directory)).isDirectory()) throw new Error("项目路径不是目录。");
  const rawRoot = (await git(directory, ["rev-parse", "--show-toplevel"])).trim();
  const root = remote ? rawRoot : await fs.realpath(rawRoot);
  const head = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  if (!SHA.test(head)) throw new Error("项目尚无有效的 Git commit。");
  return { rootPath: root, name: (remote ? path.posix : path).basename(root), headCommit: head, dirty: Boolean((await git(root, ["status", "--porcelain", "--untracked-files=normal"])).trim()) };
}
async function listTree(root, head, signal) {
  if (!SHA.test(head)) throw new Error("无效的 Git commit。");
  return (await git(root, ["ls-tree", "-r", "-z", head], { signal })).split("\0").filter(Boolean).map(entry => {
    const [header, ...names] = entry.split("\t");
    const [mode, type, oid] = header.split(" ");
    return { mode, type, oid, path: names.join("\t") };
  }).filter(entry => entry.type === "blob" && ["100644", "100755"].includes(entry.mode) && safePath(entry.path));
}
async function readSource(root, entry, signal) {
  if (!SHA.test(entry.oid) || !safePath(entry.path)) throw new Error("无效的源码定位。");
  const size = Number((await git(root, ["cat-file", "-s", entry.oid], { signal, maxBuffer: 1024 })).trim());
  if (size > MAX_SOURCE_BYTES) return null;
  const text = await git(root, ["cat-file", "blob", entry.oid], { signal, maxBuffer: MAX_SOURCE_BYTES + 4096 });
  return text.includes("\0") ? null : redact(text);
}
async function profileProject(project, signal) {
  const current = await resolveProject(project.rootPath);
  const files = await listTree(current.rootPath, current.headCommit, signal);
  const manifest = files.find(file => file.path === "package.json");
  let pkg = {};
  if (manifest) { try { pkg = JSON.parse(await readSource(current.rootPath, manifest, signal)); } catch { /* Non-JSON manifest remains a source file. */ } }
  return { ...current, files: files.map(file => file.path), fileCount: files.length,
    directories: [...new Set(files.map(file => file.path.split("/")[0]))],
    stack: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(name => ["electron", "react", "vite", "typescript", "vue", "next"].includes(name)),
    dependencies: Object.keys(pkg.dependencies || {}), entries: [pkg.main, ...files.filter(file => /(^|\/)(main|index)\.[cm]?[jt]sx?$/.test(file.path)).map(file => file.path)].filter(Boolean),
    tests: files.filter(file => /(?:\.test\.|\.spec\.|(^|\/)tests?\/)/.test(file.path)).map(file => file.path), profiledAt: Date.now() };
}
async function changedFiles(root, base, head, signal) {
  if (!SHA.test(base) || !SHA.test(head)) throw new Error("无效的 Git 增量基线。");
  return (await git(root, ["diff", "--name-only", "-z", base, head, "--"], { signal })).split("\0").filter(safePath);
}
return { git, safePath, redact, resolveProject, listTree, readSource, profileProject, changedFiles };
}
const defaults = createProfiler();
module.exports = { ...defaults, createProfiler };
