const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const nodePty = require("node-pty");
const { parse: parseToml } = require("smol-toml");

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

async function setProjectTrust(workspacePath) {
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

async function removeAddedTrust(grant) {
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

function createCodexWorkspaceTrustService({ broadcast, fsApi = fs, pty = nodePty, trustProject = setProjectTrust, listHooks = probeHooks }) {
  const pending = new Map();
  const grants = new Map();
  const publish = request => broadcast("codex-workspace-trust:changed", publicRequest(request));
  const publicRequest = request => ({ id: request.id, sessionId: request.sessionId, title: request.title,
    workspacePath: request.workspacePath, phase: request.phase, ready: request.ready, terminalOpen: Boolean(request.terminal), configPreview: request.configPreview,
    scriptPreview: request.scriptPreview, output: request.output, error: request.error });

  function listPending() { return [...pending.values()].map(publicRequest); }
  function get(id) {
    const request = pending.get(String(id));
    if (!request) throw new Error("Codex 工作区信任请求已失效。");
    return request;
  }
  function request({ sessionId, title, workspacePath }) {
    if (pending.has(sessionId)) throw new Error("该会话已有待处理的信任请求。");
    return new Promise((resolve, reject) => {
      const entry = { id: sessionId, sessionId, title, workspacePath, phase: "project", error: "", output: "",
        configPreview: "", scriptPreview: "", ready: false, resolve, reject, terminal: null };
      pending.set(sessionId, entry);
      void (async () => {
        try {
          const codexDir = path.join(workspacePath, ".codex");
          const [configPreview, scriptPreview] = await Promise.all([
            fsApi.promises.readFile(path.join(codexDir, "hooks.json"), "utf8"),
            fsApi.promises.readFile(path.join(codexDir, "pannel-handle-hook.ps1"), "utf8")
          ]);
          if (pending.get(sessionId) !== entry) return;
          entry.configPreview = configPreview.slice(0, MAX_PREVIEW);
          entry.scriptPreview = scriptPreview.slice(0, MAX_PREVIEW);
          entry.ready = true;
          publish(entry);
        } catch (error) {
          if (pending.get(sessionId) !== entry) return;
          pending.delete(sessionId);
          broadcast("codex-workspace-trust:resolved", { id: sessionId });
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
    try { grant = await trustProject(entry.workspacePath); }
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
      cwd: entry.workspacePath, cols: 92, rows: 28, env: { ...process.env, TERM: "xterm-256color" }, name: "xterm-256color"
    });
    entry.terminal = terminal;
    terminal.onData(data => {
      entry.output = (entry.output + data).slice(-MAX_TERMINAL_OUTPUT);
      broadcast("codex-workspace-trust:output", { id: entry.id, data });
    });
    terminal.onExit(() => {
      if (entry.terminal === terminal) {
        entry.terminal = null;
        if (pending.get(entry.id) === entry) publish(entry);
      }
    });
    publish(entry);
    return publicRequest(entry);
  }
  function writeTerminal(id, data) {
    const entry = get(id);
    if (!entry.terminal || typeof data !== "string" || data.length > 4096) throw new Error("Hook 审核终端不可用。");
    entry.terminal.write(data);
  }
  function resizeTerminal(id, cols, rows) {
    const entry = get(id);
    entry.terminal?.resize(Math.max(40, Math.min(240, Number(cols) || 92)), Math.max(12, Math.min(80, Number(rows) || 28)));
  }
  async function finishHooks(id) {
    const entry = get(id);
    if (entry.phase !== "hooks") throw new Error("请先信任当前工作区。");
    if (entry.finishBusy) throw new Error("正在检查 Hook 信任状态。");
    entry.finishBusy = true;
    let hooks;
    try { hooks = await listHooks(entry.workspacePath); }
    finally { entry.finishBusy = false; }
    if (pending.get(entry.id) !== entry) throw new Error("Codex 工作区信任请求已失效。");
    const expected = path.win32.join(entry.workspacePath, ".codex", "hooks.json").toLowerCase();
    const projectHooks = hooks.filter(hook => hook.source === "project" && String(hook.sourcePath || "").toLowerCase() === expected);
    if (!projectHooks.length || projectHooks.some(hook => hook.trustStatus !== "trusted")) {
      entry.error = "当前工作区的 Hook 尚未全部受信任，请在 /hooks 中完成审核。";
      publish(entry);
      return false;
    }
    const terminal = entry.terminal;
    entry.terminal = null;
    terminal?.kill();
    pending.delete(entry.id);
    broadcast("codex-workspace-trust:resolved", { id: entry.id });
    entry.resolve();
    return true;
  }
  function cancel(id) {
    const entry = get(id);
    const terminal = entry.terminal;
    entry.terminal = null;
    terminal?.kill();
    pending.delete(entry.id);
    broadcast("codex-workspace-trust:resolved", { id: entry.id });
    entry.reject(new Error("已取消 Codex 工作区信任，图形会话未启动。"));
    return true;
  }
  async function release(sessionId) {
    if (pending.has(sessionId)) cancel(sessionId);
    const grant = grants.get(sessionId);
    grants.delete(sessionId);
    if (grant) await removeAddedTrust(grant);
  }
  return { request, listPending, approveProject, openHooks, writeTerminal, resizeTerminal, finishHooks, cancel, release };
}

module.exports = { createCodexWorkspaceTrustService, setProjectTrust, removeAddedTrust, probeHooks };
