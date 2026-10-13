const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const nodePty = require("./codex-workspace-trust-pty.cjs");
const { parse: parseToml } = require("smol-toml");
const { withTrustLock, copyNativeHookTrust, removeCopiedHookTrust, createHostTrustStore } = require("./codex-bridge-trust.cjs");

const MAX_PREVIEW = 24000;
const MAX_TERMINAL_OUTPUT = 64000;

function configPath() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
}

function projectKey(workspacePath) {
  return path.win32.resolve(workspacePath).toLowerCase();
}

function tableHeader(key) {
  return `[projects.${JSON.stringify(key)}]`;
}

function findProjectSection(source, key) {
  const lines = source.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!/^\[/.test(line)) continue;
    if (start >= 0) { end = index; break; }
    if (line === tableHeader(key)) start = index;
  }
  return { lines, start, end };
}

async function setProjectTrustUnlocked(workspacePath) {
  const target = configPath();
  const key = projectKey(workspacePath);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const original = await fs.promises.readFile(target, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const parsed = original ? parseToml(original) : {};
  const existing = parsed.projects?.[key]?.trust_level;
  if (existing === "trusted") return { target, key, added: false, previous: "trusted" };
  const { lines, start, end } = findProjectSection(original, key);
  let next;
  if (start >= 0) {
    const index = lines.findIndex((line, offset) => offset > start && offset < end && /^\s*trust_level\s*=/.test(line));
    if (index < 0) lines.splice(start + 1, 0, 'trust_level = "trusted"');
    else lines[index] = 'trust_level = "trusted"';
    next = lines.join(original.includes("\r\n") ? "\r\n" : "\n");
  } else {
    next = `${original.trimEnd()}${original ? "\n\n" : ""}${tableHeader(key)}\ntrust_level = "trusted"\n`;
  }
  if (parseToml(next).projects?.[key]?.trust_level !== "trusted") throw new Error("Codex 项目信任配置校验失败。");
  const current = await fs.promises.readFile(target, "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error));
  if (current !== original) throw new Error("Codex 配置已变化，请重试信任操作。");
  const temp = `${target}.pannel-handle-${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temp, next, { encoding: "utf8", flag: "wx" });
    await fs.promises.rename(temp, target);
  } finally {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
  }
  return { target, key, added: existing === undefined, previous: existing };
}

async function removeAddedTrustUnlocked(grant) {
  if (!grant || (!grant.added && grant.previous !== "untrusted")) return;
  const source = await fs.promises.readFile(grant.target, "utf8").catch(() => "");
  const { lines, start, end } = findProjectSection(source, grant.key);
  if (start < 0 || parseToml(source).projects?.[grant.key]?.trust_level !== "trusted") return;
  if (grant.added) {
    const section = lines.slice(start + 1, end).filter(line => line.trim() && !line.trim().startsWith("#"));
    if (section.length !== 1 || section[0].trim() !== 'trust_level = "trusted"') return;
    lines.splice(start, end - start);
  } else {
    const index = lines.findIndex((line, offset) => offset > start && offset < end && line.trim() === 'trust_level = "trusted"');
    if (index < 0) return;
    lines[index] = 'trust_level = "untrusted"';
  }
  const next = `${lines.join(source.includes("\r\n") ? "\r\n" : "\n").trimEnd()}\n`;
  if (next.trim()) parseToml(next);
  if (await fs.promises.readFile(grant.target, "utf8") !== source) return;
  const temp = `${grant.target}.pannel-handle-${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temp, next, { encoding: "utf8", flag: "wx" });
    if (await fs.promises.readFile(grant.target, "utf8") !== source) return;
    await fs.promises.rename(temp, grant.target);
  } finally {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
  }
}

function setProjectTrust(workspacePath) { return withTrustLock(() => setProjectTrustUnlocked(workspacePath)); }
function removeAddedTrust(grant) { return withTrustLock(() => removeAddedTrustUnlocked(grant)); }

async function isProjectTrusted(workspacePath) {
  const source = await fs.promises.readFile(configPath(), "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return Boolean(source && parseToml(source).projects?.[projectKey(workspacePath)]?.trust_level === "trusted");
}

function projectHooksTrusted(hooks, workspacePath) {
  const expected = path.win32.join(workspacePath, ".codex", "hooks.json").toLowerCase();
  const projectHooks = hooks.filter(hook => hook.source === "project" && String(hook.sourcePath || "").toLowerCase() === expected);
  return projectHooks.length > 0 && projectHooks.every(hook => hook.trustStatus === "trusted");
}

function scriptDigest(source) { return createHash("sha256").update(source).digest("hex"); }
function approvalPath(workspacePath) { return path.join(workspacePath, ".codex", "pannel-handle-trust.json"); }

function probeHooks(workspacePath) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "& codex app-server --stdio"],
      { cwd: workspacePath, windowsHide: true });
    let output = "";
    let settled = false;
    const finish = (error, hooks) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      if (error) child.kill();
      if (error) reject(error); else resolve(hooks);
    };
    const timer = setTimeout(() => finish(new Error("Codex Hook 状态查询超时。")), 12000);
    child.on("error", error => finish(error));
    child.stderr.on("data", () => {});
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      const rows = output.split("\n");
      output = rows.pop() || "";
      for (const row of rows) {
        let value;
        try { value = JSON.parse(row); } catch { continue; }
        if (value.id === 1 && value.result) {
          child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: "hooks/list", params: { cwds: [workspacePath] } })}\n`);
        }
        if (value.id === 2) {
          if (value.error) finish(new Error(value.error.message || "无法读取 Codex Hook 状态。"));
          else finish(null, value.result?.data?.[0]?.hooks || []);
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "pannel_handle", title: "Pannel Handle", version: "0.1.0" } } })}\n`);
  });
}

function createCodexWorkspaceTrustService({ broadcast, fsApi = fs, pty = nodePty, trustProject = setProjectTrustUnlocked,
  listHooks = probeHooks, projectTrusted = isProjectTrusted, hostTrustRoot, workspacesRoot }) {
  const pending = new Map();
  const grants = new Map();
  const hostStore = createHostTrustStore(hostTrustRoot);
  const publish = request => broadcast("codex-workspace-trust:changed", publicRequest(request));
  const publicRequest = request => ({ id: request.id, sessionId: request.sessionId, title: request.title,
    workspacePath: request.workspacePath, persistent: Boolean(request.persistent), hostTrustLabel: request.hostTrustLabel, phase: request.phase, ready: request.ready, terminalOpen: Boolean(request.terminal), configPreview: request.configPreview,
    scriptPreview: request.scriptPreview, output: request.output, error: request.error });

  // A persistent request may resolve without review after probing Codex. Do not
  // expose it to a renderer mounting during that probe as a new trust prompt.
  function listPending() { return [...pending.values()].filter(entry => entry.reviewRequired).map(publicRequest); }
  function get(id) {
    const request = pending.get(String(id));
    if (!request) throw new Error("Codex 工作区信任请求已失效。");
    return request;
  }
  function detachTerminal(entry) {
    const terminal = entry.terminal;
    entry.terminal = null;
    for (const listener of entry.terminalListeners || []) listener.dispose();
    entry.terminalListeners = [];
    return terminal;
  }
  function complete(entry) {
    if (pending.get(entry.id) !== entry) return;
    pending.delete(entry.id);
    const terminal = detachTerminal(entry);
    broadcast("codex-workspace-trust:resolved", { id: entry.id });
    // Cleanup failure must not leave the launch promise pending.
    try { terminal?.kill(); }
    catch (error) { console.warn("Codex Hook 审核终端关闭失败：", error); }
  }
  const active = entry => pending.get(entry.id) === entry;
  async function contentMatches(workspacePath, record) {
    if (!workspacePath || !record) return false;
    const [config, script] = await Promise.all([
      fsApi.promises.readFile(path.join(workspacePath, ".codex", "hooks.json"), "utf8"),
      fsApi.promises.readFile(path.join(workspacePath, ".codex", "pannel-handle-hook.ps1"), "utf8")
    ]);
    return scriptDigest(config) === record.configHash && scriptDigest(script) === record.scriptHash;
  }
  async function saveHostApproval(entry) {
    if (!entry.hostTrustKey || !active(entry)) return;
    if (!await contentMatches(entry.workspacePath, entry)) throw new Error("Hook 内容已变化，请重新审核。");
    await hostStore.save(entry.hostTrustKey, { workspacePath: entry.workspacePath,
      configHash: entry.configHash, scriptHash: entry.scriptHash, codexConfigPath: configPath() }, () => active(entry));
  }
  async function reuseHostApproval(entry) {
    return withTrustLock(async () => {
      if (!active(entry) || !entry.persistent || !entry.hostTrustKey || entry.reuseBlocked) return false;
      const record = await hostStore.read(entry.hostTrustKey);
      if (!record || record.codexConfigPath !== configPath() || record.configHash !== entry.configHash || record.scriptHash !== entry.scriptHash) return false;
      // Old records without a reliable host identity are never scanned/adopted.
      if (workspacesRoot) {
        const relative = path.relative(path.resolve(workspacesRoot), path.resolve(record.workspacePath || "."));
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
      }
      if (!await contentMatches(record.workspacePath, record) || !await projectTrusted(record.workspacePath)) return false;
      const hooks = await listHooks(record.workspacePath);
      if (!active(entry) || !projectHooksTrusted(hooks, record.workspacePath)) return false;
      const config = parseToml(await fsApi.promises.readFile(configPath(), "utf8"));
      if (config.projects?.[projectKey(entry.workspacePath)]?.trust_level === "untrusted") return false;
      if (!await contentMatches(entry.workspacePath, entry) || !await contentMatches(record.workspacePath, record) || !active(entry)) return false;
      const grant = await trustProject(entry.workspacePath);
      let accepted = false;
      let hookGrant;
      try {
        if (!active(entry)) return false;
        hookGrant = await copyNativeHookTrust(configPath(), record.workspacePath, entry.workspacePath, hooks);
        if (!hookGrant) return false;
        const targetHooks = await listHooks(entry.workspacePath);
        if (!active(entry) || !projectHooksTrusted(targetHooks, entry.workspacePath)
          || !await projectTrusted(entry.workspacePath) || !await contentMatches(entry.workspacePath, entry)) return false;
        await fsApi.promises.writeFile(approvalPath(entry.workspacePath), JSON.stringify({ scriptHash: entry.scriptHash, configHash: entry.configHash }), "utf8");
        if (!active(entry)) return false;
        accepted = true;
        grants.delete(entry.sessionId);
        complete(entry);
        entry.resolve();
        return true;
      } finally {
        if (!accepted) {
          try { await removeCopiedHookTrust(hookGrant); }
          finally { await removeAddedTrustUnlocked(grant); }
        }
      }
    });
  }
  function retryHostRequests(entry) {
    for (const other of pending.values()) {
      if (other === entry || other.hostTrustKey !== entry.hostTrustKey || !other.ready || other.finishBusy || other.projectBusy || other.terminal) continue;
      void reuseHostApproval(other).catch(error => {
        if (active(other)) { other.error = error.message || String(error); publish(other); }
      });
    }
  }
  function request({ sessionId, title, workspacePath, persistent = false, hostTrustKey, hostTrustLabel }) {
    if ([...pending.values()].some(entry => entry.sessionId === sessionId)) throw new Error("该会话已有待处理的信任请求。");
    return new Promise((resolve, reject) => {
      const entry = { id: randomUUID(), sessionId, title, workspacePath, persistent, hostTrustKey, hostTrustLabel, phase: "project", error: "", output: "",
        configPreview: "", scriptPreview: "", ready: false, resolve, reject, terminal: null };
      pending.set(entry.id, entry);
      void (async () => {
        try {
          const codexDir = path.join(workspacePath, ".codex");
          const [configPreview, scriptPreview] = await Promise.all([
            fsApi.promises.readFile(path.join(codexDir, "hooks.json"), "utf8"),
            fsApi.promises.readFile(path.join(codexDir, "pannel-handle-hook.ps1"), "utf8")
          ]);
          if (pending.get(entry.id) !== entry) return;
          entry.configPreview = configPreview.slice(0, MAX_PREVIEW);
          entry.scriptPreview = scriptPreview.slice(0, MAX_PREVIEW);
          entry.scriptHash = scriptDigest(scriptPreview);
          entry.configHash = scriptDigest(configPreview);
          if (persistent && await projectTrusted(workspacePath)) {
            entry.phase = "hooks";
            let approval;
            try { approval = JSON.parse(await fsApi.promises.readFile(approvalPath(workspacePath), "utf8")); }
            catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
            try {
              const hooks = await listHooks(workspacePath);
              if (pending.get(entry.id) !== entry) return;
              // Native revocation may delete the state entry entirely. A local
              // completed review distinguishes that from a never-reviewed slot.
              if (approval?.scriptHash === entry.scriptHash && (!approval.configHash || approval.configHash === entry.configHash)
                && !projectHooksTrusted(hooks, workspacePath)) entry.reuseBlocked = true;
              if (approval?.scriptHash === entry.scriptHash && (!approval.configHash || approval.configHash === entry.configHash)
                && projectHooksTrusted(hooks, workspacePath) && await contentMatches(workspacePath, entry) && await projectTrusted(workspacePath)) {
                if (!approval.configHash) {
                  await fsApi.promises.writeFile(approvalPath(workspacePath), JSON.stringify({ scriptHash: entry.scriptHash, configHash: entry.configHash }), "utf8");
                }
                await withTrustLock(() => saveHostApproval(entry));
                if (!active(entry)) return;
                complete(entry);
                resolve();
                retryHostRequests(entry);
                return;
              }
            } catch (error) { entry.error = error.message || String(error); }
          }
          try { if (await reuseHostApproval(entry)) return; }
          catch (error) { entry.error = error.message || String(error); }
          if (pending.get(entry.id) === entry) {
            entry.ready = true;
            entry.reviewRequired = true;
            publish(entry);
          }
        } catch (error) {
          if (pending.get(entry.id) !== entry) return;
          complete(entry);
          reject(error);
        }
      })();
    });
  }
  async function approveProject(id) {
    const entry = get(id);
    if (entry.phase !== "project") throw new Error("当前请求不在项目信任步骤。");
    if (!entry.ready) throw new Error("Hook 内容仍在读取中，请稍后重试。");
    if (entry.projectBusy) throw new Error("正在保存项目信任配置。");
    entry.projectBusy = true;
    let grant;
    try { grant = await withTrustLock(() => trustProject(entry.workspacePath)); }
    finally { entry.projectBusy = false; }
    if (pending.get(entry.id) !== entry) {
      await removeAddedTrust(grant);
      throw new Error("Codex 工作区信任请求已失效。");
    }
    grants.set(entry.sessionId, grant);
    entry.phase = "hooks";
    entry.error = "";
    publish(entry);
    return publicRequest(entry);
  }
  function openHooks(id) {
    const entry = get(id);
    if (entry.phase !== "hooks") throw new Error("请先信任当前工作区。");
    if (entry.terminal) {
      entry.terminal.write("/hooks\r");
      return publicRequest(entry);
    }
    const command = `& codex -C '${entry.workspacePath.replace(/'/g, "''")}' -s read-only -a never`;
    const terminal = pty.spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", command], {
      cwd: entry.workspacePath, cols: 92, rows: 28, env: { ...process.env, TERM: "xterm-256color" }, name: "xterm-256color", useConptyDll: true
    });
    entry.terminal = terminal;
    entry.terminalListeners = [terminal.onData(data => {
      if (pending.get(entry.id) !== entry || entry.terminal !== terminal) return;
      entry.output = (entry.output + data).slice(-MAX_TERMINAL_OUTPUT);
      broadcast("codex-workspace-trust:output", { id: entry.id, data });
    }), terminal.onExit(() => {
      if (entry.terminal === terminal) {
        detachTerminal(entry);
        if (pending.get(entry.id) === entry) publish(entry);
      }
    })];
    publish(entry);
    return publicRequest(entry);
  }
  function writeTerminal(id, data) {
    const entry = pending.get(String(id));
    if (!entry) return;
    if (!entry.terminal || typeof data !== "string" || data.length > 4096) throw new Error("Hook 审核终端不可用。");
    entry.terminal.write(data);
  }
  function resizeTerminal(id, cols, rows) {
    const entry = pending.get(String(id));
    if (!entry) return;
    entry.terminal?.resize(Math.max(40, Math.min(240, Number(cols) || 92)), Math.max(12, Math.min(80, Number(rows) || 28)));
  }
  async function finishHooks(id) {
    const entry = get(id);
    if (entry.phase !== "hooks") throw new Error("请先信任当前工作区。");
    if (entry.finishBusy) throw new Error("正在检查 Hook 信任状态。");
    entry.finishBusy = true;
    try {
      const hooks = await listHooks(entry.workspacePath);
      if (pending.get(entry.id) !== entry) throw new Error("Codex 工作区信任请求已失效。");
      const script = await fsApi.promises.readFile(path.join(entry.workspacePath, ".codex", "pannel-handle-hook.ps1"), "utf8");
      if (scriptDigest(script) !== entry.scriptHash) throw new Error("Hook 脚本已变化，请取消并重新启动会话后审核。");
      if (!await contentMatches(entry.workspacePath, entry)) throw new Error("Hook 配置已变化，请取消并重新启动会话后审核。");
      if (entry.persistent && !await projectTrusted(entry.workspacePath)) throw new Error("当前工作区信任已被撤销，请取消并重新启动会话。");
      if (pending.get(entry.id) !== entry) throw new Error("Codex 工作区信任请求已失效。");
      if (!projectHooksTrusted(hooks, entry.workspacePath)) {
        entry.error = "当前工作区的 Hook 尚未全部受信任，请在 /hooks 中完成审核。";
        publish(entry);
        return false;
      }
      if (entry.persistent) {
        await fsApi.promises.writeFile(approvalPath(entry.workspacePath), JSON.stringify({ scriptHash: entry.scriptHash, configHash: entry.configHash }), "utf8");
        if (pending.get(entry.id) !== entry) throw new Error("Codex 工作区信任请求已失效。");
        await withTrustLock(() => saveHostApproval(entry));
        if (!active(entry)) throw new Error("Codex 工作区信任请求已失效。");
        grants.delete(entry.sessionId);
      }
      complete(entry);
      entry.resolve();
      retryHostRequests(entry);
      return true;
    } finally { entry.finishBusy = false; }
  }

  function cancel(id) {
    const entry = get(id);
    complete(entry);
    entry.reject(new Error("已取消 Codex 工作区信任，图形会话未启动。"));
    return true;
  }
  async function release(sessionId) {
    const entry = [...pending.values()].find(request => request.sessionId === sessionId);
    if (entry) cancel(entry.id);
    const grant = grants.get(sessionId);
    grants.delete(sessionId);
    if (grant) await removeAddedTrust(grant);
  }
  return { request, listPending, approveProject, openHooks, writeTerminal, resizeTerminal, finishHooks, cancel, release };
}

module.exports = { createCodexWorkspaceTrustService, setProjectTrust, removeAddedTrust, probeHooks };
