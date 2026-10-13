const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { parse: parseToml } = require("smol-toml");

// All application writes to Codex trust share this queue, including cleanup.
let writes = Promise.resolve();
function withTrustLock(action) {
  const result = writes.then(action);
  writes = result.catch(() => {});
  return result;
}

async function atomicWrite(file, source, expected, isActive = () => true) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.pannel-handle-${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temp, source, { encoding: "utf8", flag: "wx" });
    if (expected !== undefined && await fs.promises.readFile(file, "utf8") !== expected) {
      throw new Error("Codex 配置已变化，请重试信任操作。");
    }
    if (!isActive()) throw new Error("Codex 工作区信任请求已失效。");
    await fs.promises.rename(temp, file);
  } finally {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
  }
}

function projectHooks(hooks, workspacePath) {
  const expected = path.win32.join(workspacePath, ".codex", "hooks.json").toLowerCase();
  return hooks.filter(hook => hook.source === "project" && String(hook.sourcePath || "").toLowerCase() === expected);
}

// Reuse only the native hashes returned for the reviewed project. Never invent
// hashes or copy user/plugin hooks, disabled entries, or revoked target entries.
async function copyNativeHookTrust(configFile, sourceWorkspace, targetWorkspace, hooks) {
  const original = await fs.promises.readFile(configFile, "utf8");
  const config = parseToml(original);
  const selected = projectHooks(hooks, sourceWorkspace);
  const sourcePath = path.win32.join(sourceWorkspace, ".codex", "hooks.json");
  const targetPath = path.win32.join(targetWorkspace, ".codex", "hooks.json");
  if (!selected.length) return false;
  const additions = [];
  const added = [];
  for (const hook of selected) {
    if (hook.trustStatus !== "trusted" || hook.enabled === false || !/^sha256:[a-f0-9]{64}$/.test(hook.currentHash || "")
      || hook.handlerType !== "command" || hook.command !== "powershell.exe -NoProfile -ExecutionPolicy Bypass -File .codex/pannel-handle-hook.ps1"
      || !String(hook.key || "").toLowerCase().startsWith(`${sourcePath.toLowerCase()}:`)) return false;
    const sourceState = config.hooks?.state?.[hook.key];
    if (sourceState?.trusted_hash !== hook.currentHash || sourceState.enabled === false) return false;
    const key = targetPath + hook.key.slice(sourcePath.length);
    const targetState = config.hooks?.state?.[key];
    if (targetState) {
      if (targetState.trusted_hash !== hook.currentHash || targetState.enabled === false) return false;
    } else {
      additions.push(`[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hook.currentHash)}`);
      added.push({ key, hash: hook.currentHash });
    }
  }
  if (additions.length) {
    const next = `${original.trimEnd()}\n\n${additions.join("\n\n")}\n`;
    parseToml(next);
    await atomicWrite(configFile, next, original);
  }
  return { configFile, added };
}

async function removeCopiedHookTrust(grant) {
  if (!grant?.added.length) return;
  const original = await fs.promises.readFile(grant.configFile, "utf8");
  const config = parseToml(original);
  const lines = original.split(/\r?\n/);
  for (const { key, hash } of grant.added) {
    const state = config.hooks?.state?.[key];
    if (state?.trusted_hash !== hash || Object.keys(state).length !== 1) continue;
    const start = lines.findIndex(line => line.trim() === `[hooks.state.${JSON.stringify(key)}]`);
    if (start < 0) continue;
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
    lines.splice(start, end - start);
  }
  const next = `${lines.join(original.includes("\r\n") ? "\r\n" : "\n").trimEnd()}\n`;
  parseToml(next);
  if (next !== original) await atomicWrite(grant.configFile, next, original);
}

function createHostTrustStore(root) {
  return {
    async read(key) {
      if (!root || !/^[a-f0-9]{64}$/.test(key || "")) return null;
      try {
        const record = JSON.parse(await fs.promises.readFile(path.join(root, `${key}.json`), "utf8"));
        return record.version === 1 ? record : null;
      } catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
        throw error;
      }
    },
    async save(key, record, isActive) {
      if (!root || !/^[a-f0-9]{64}$/.test(key || "")) return;
      await atomicWrite(path.join(root, `${key}.json`), JSON.stringify({ version: 1, ...record }), undefined, isActive);
    }
  };
}

module.exports = { withTrustLock, copyNativeHookTrust, removeCopiedHookTrust, createHostTrustStore, projectHooks };
