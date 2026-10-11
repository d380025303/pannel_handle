const path = require("node:path");
const { spawn } = require("node:child_process");
const { builtinModules } = require("node:module");
const { listTree, changedFiles, readSource } = require("./project-profiler.cjs");
const SOURCE = /\.[cm]?[jt]sx?$/;
const GLOBAL = /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|tsconfig[^/]*\.json|vite\.config\.[^/]+|preload\.cjs|vite-env\.d\.ts)$/;

function batch(root, oids, check, signal, limit) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "cat-file", check ? "--batch-check" : "--batch"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks = []; let bytes = 0, settled = false;
    function finish(error) {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) { child.kill(); reject(error); } else resolve(Buffer.concat(chunks));
    }
    const abort = () => finish(signal.reason || new Error("依赖分析已取消。"));
    const timer = setTimeout(() => finish(new Error("依赖分析超过时间限制。")), 10000);
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > limit) finish(new Error("依赖图超过预算。")); else chunks.push(chunk); });
    child.stderr.on("data", () => {}); child.stdin.on("error", finish); child.on("error", finish);
    child.on("close", code => finish(code === 0 ? null : new Error("Git 依赖快照读取失败。")));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort(); else child.stdin.end(oids.join("\n") + "\n");
  });
}
async function detectImpact({ root, base, head, signal, maxFiles = 2000, maxBytes = 8 * 1024 * 1024 }) {
  const changed = await changedFiles(root, base, head, signal);
  const full = reason => ({ changed, paths: null, full: true, reason });
  if (!changed.length) return { changed, paths: [], full: false, reason: "no-changes" };
  if (changed.some(file => GLOBAL.test(file) || !SOURCE.test(file))) return full("shared-config-or-unsupported-source");
  const tree = await listTree(root, head, signal);
  const configurationFiles = tree.filter(file => /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+)$/.test(file.path));
  if (configurationFiles.length > 32) return full("dependency-configuration-limit");
  const packages = new Set(builtinModules);
  const localPackages = new Set();
  for (const manifest of tree.filter(file => /(?:^|\/)package\.json$/.test(file.path))) {
    try {
      const pkg = JSON.parse(await readSource(root, manifest, signal));
      if (manifest.path !== "package.json" && pkg.name) localPackages.add(pkg.name);
      if (manifest.path === "package.json") for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) packages.add(name);
    } catch { return full("unreadable-package-graph"); }
  }
  for (const name of localPackages) packages.delete(name);
  for (const configuration of tree.filter(file => /(?:^|\/)(?:tsconfig[^/]*\.json|vite\.config\.[^/]+)$/.test(file.path))) {
    const source = await readSource(root, configuration, signal);
    if (!source || /["']paths["']\s*:|\balias\s*[:=]/.test(source)) return full("custom-module-resolution");
  }
  const files = tree.filter(file => SOURCE.test(file.path));
  if (files.length > maxFiles) return full("dependency-file-limit");
  if (!files.length) return full("no-source-graph");
  try {
    const metadata = (await batch(root, files.map(file => file.oid), true, signal, maxFiles * 160)).toString("utf8").trim().split("\n");
    const sizes = metadata.map((line, index) => {
      const [oid, type, size] = line.split(" ");
      if (oid !== files[index]?.oid || type !== "blob" || !/^\d+$/.test(size)) throw new Error("Git 快照响应无效。");
      return Number(size);
    });
    if (sizes.length !== files.length || sizes.some(size => size > 128 * 1024) || sizes.reduce((sum, size) => sum + size, 0) > maxBytes) return full("dependency-byte-limit");
    const data = await batch(root, files.map(file => file.oid), false, signal, maxBytes + maxFiles * 160);
    const existing = new Set([...tree.map(file => file.path), ...changed]);
    const reverse = new Map(); let offset = 0;
    for (let index = 0; index < files.length; index++) {
      const newline = data.indexOf(10, offset);
      const header = data.subarray(offset, newline).toString("utf8");
      if (newline < 0 || header !== `${files[index].oid} blob ${sizes[index]}`) return full("invalid-dependency-snapshot");
      const bytes = data.subarray(newline + 1, newline + 1 + sizes[index]); offset = newline + sizes[index] + 2;
      if (bytes.includes(0)) return full("binary-source");
      const source = bytes.toString("utf8");
      if (/\b(?:require|import)\s*\(\s*[^\s'"`]/.test(source) || /\b(?:require|import)\s*\(\s*`/.test(source)) return full("dynamic-module-reference");
      const references = source.matchAll(/(?:\b(?:require|import)\s*\(\s*|\bfrom\s*|\bimport\s*)['"]([^'"\r\n]+)['"]/g);
      for (const [, specifier] of references) {
        if (!specifier.startsWith(".")) {
          if (specifier.startsWith("@/") || specifier.startsWith("~/") || specifier.startsWith("#")) return full("unresolved-module-alias");
          const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
          if (!specifier.startsWith("node:") && !packages.has(packageName)) return full("unresolved-package-or-alias");
          continue;
        }
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(files[index].path), specifier));
        const candidates = [target, ...[".js", ".jsx", ".ts", ".tsx", ".cjs", ".mjs"].flatMap(extension => [target + extension, target + "/index" + extension])];
        if (/\.js$/.test(target)) candidates.push(target.slice(0, -3) + ".ts", target.slice(0, -3) + ".tsx");
        const resolved = candidates.find(candidate => existing.has(candidate));
        if (!resolved) return full("unresolved-local-dependency");
        if (!reverse.has(resolved)) reverse.set(resolved, new Set());
        reverse.get(resolved).add(files[index].path);
      }
    }
    if (offset !== data.length) return full("invalid-dependency-trailer");
    const impacted = new Set(changed); const queue = [...changed];
    for (let index = 0; index < queue.length; index++) for (const consumer of reverse.get(queue[index]) || []) if (!impacted.has(consumer)) { impacted.add(consumer); queue.push(consumer); }
    return { changed, paths: [...impacted].sort(), full: false, reason: "transitive-local-dependencies" };
  } catch (error) {
    signal?.throwIfAborted();
    return full("dependency-analysis-unavailable");
  }
}
module.exports = { detectImpact };
