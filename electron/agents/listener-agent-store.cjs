const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { CronExpressionParser } = require("cron-parser");

const PROVIDERS = new Set(["claude", "codex", "opencode", "qoder"]);
const TRIGGER_TYPES = new Set(["file", "interval", "cron", "manual"]);
const EVENTS = new Set(["add", "change", "unlink"]);
const PROMPT_VARIABLES = new Set(["cwd", "agent.name", "trigger.type", "trigger.time", "changedFiles", "schedule"]);
const DEFAULT_EXCLUDES = ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/release/**"];
const MAX_OUTPUT_BYTES = 1024 * 1024;

function stringList(value, fallback = []) {
  if (!Array.isArray(value)) return [...fallback];
  return value.map(item => String(item || "").trim().replace(/\\/g, "/")).filter(Boolean);
}

function validatePrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text) throw new Error("触发器提示词不能为空。");
  const unknown = [...text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)]
    .map(match => match[1])
    .filter(name => !PROMPT_VARIABLES.has(name));
  if (unknown.length) throw new Error(`不支持的提示词变量：${[...new Set(unknown)].join(", ")}`);
  return text;
}

function normalizeTrigger(trigger = {}) {
  const type = TRIGGER_TYPES.has(trigger.type) ? trigger.type : "file";
  const normalized = {
    id: String(trigger.id || randomUUID()),
    name: String(trigger.name || "触发器").trim() || "触发器",
    type,
    enabled: trigger.enabled !== false,
    prompt: validatePrompt(trigger.prompt)
  };
  if (type === "file") {
    return {
      ...normalized,
      include: stringList(trigger.include, ["**/*"]),
      exclude: stringList(trigger.exclude, DEFAULT_EXCLUDES),
      events: stringList(trigger.events, ["add", "change", "unlink"]).filter(event => EVENTS.has(event)),
      debounceMs: 1000
    };
  }
  if (type === "manual") {
    return normalized;
  }
  if (type === "interval") {
    const intervalMinutes = Number(trigger.intervalMinutes);
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 525600) {
      throw new Error("固定间隔必须在 1 到 525600 分钟之间。");
    }
    return { ...normalized, intervalMinutes: Math.floor(intervalMinutes) };
  }
  const cron = String(trigger.cron || "").trim();
  if (cron.split(/\s+/).length !== 5) throw new Error("Cron 必须是 5 段表达式。");
  CronExpressionParser.parse(cron);
  return { ...normalized, cron };
}

function normalizeListenerAgent(agent = {}) {
  const cliTemplateId = String(agent.cliTemplateId || "").trim() || undefined;
  if (!cliTemplateId && !PROVIDERS.has(agent.provider)) throw new Error("请选择有效的 Agent CLI。");
  const triggers = Array.isArray(agent.triggers) ? agent.triggers.map(normalizeTrigger) : [];
  if (!triggers.length) throw new Error("监听 Agent 至少需要一个触发器。");
  const timeoutMinutes = Number(agent.timeoutMinutes ?? 30);
  return {
    id: String(agent.id || randomUUID()),
    name: String(agent.name || "监听 Agent").trim() || "监听 Agent",
    provider: cliTemplateId && !PROVIDERS.has(agent.provider) ? "codex" : agent.provider,
    cliTemplateId,
    enabled: agent.enabled !== false,
    permission: agent.permission === "write" ? "write" : "read-only",
    timeoutMinutes: Number.isFinite(timeoutMinutes) ? Math.min(120, Math.max(1, Math.floor(timeoutMinutes))) : 30,
    ignoreOwnChanges: agent.ignoreOwnChanges !== false,
    triggers
  };
}

function normalizeListenerAgents(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeListenerAgent);
}

function renderPrompt({ prompt, cwd, agent, trigger, changedFiles = [], now = new Date() }) {
  const safeChangedFiles = changedFiles.slice(0, 200).map(file => String(file).slice(0, 500));
  const schedule = trigger.type === "cron"
    ? trigger.cron
    : trigger.type === "interval" ? `每 ${trigger.intervalMinutes} 分钟`
    : trigger.type === "manual" ? "手动触发"
    : "文件变化";
  const values = {
    cwd,
    "agent.name": agent.name,
    "trigger.type": trigger.type,
    "trigger.time": now.toISOString(),
    changedFiles: safeChangedFiles.join("\n"),
    schedule
  };
  const rendered = prompt.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, name) => values[name] ?? "");
  return `${rendered}\n\n触发上下文：\n- 工作目录：${cwd}\n- 触发类型：${trigger.type}\n- 触发时间：${values["trigger.time"]}\n- 变更文件：${safeChangedFiles.length ? safeChangedFiles.join(", ") : "无"}${changedFiles.length > safeChangedFiles.length ? `（另有 ${changedFiles.length - safeChangedFiles.length} 项）` : ""}`;
}

function truncateOutput(value, limit = MAX_OUTPUT_BYTES) {
  const buffer = Buffer.from(String(value || ""), "utf-8");
  if (buffer.length <= limit) return { value: buffer.toString("utf-8"), truncated: false };
  return { value: buffer.subarray(0, limit).toString("utf-8"), truncated: true };
}

function createListenerAgentStore({ historyFile, maxEntries = 100 }) {
  let histories = {};

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(historyFile, "utf-8"));
      histories = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      if (err.code !== "ENOENT") console.error("Failed to load listener Agent history:", err);
      histories = {};
    }
  }

  function save() {
    const tmp = `${historyFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(histories, null, 2), "utf-8");
    fs.renameSync(tmp, historyFile);
  }

  function append(templateId, agentId, run) {
    const key = `${templateId}:${agentId}`;
    const stdout = truncateOutput(run.stdout);
    const stderr = truncateOutput(run.stderr);
    const entry = { ...run, stdout: stdout.value, stderr: stderr.value, truncated: stdout.truncated || stderr.truncated };
    histories[key] = [entry, ...(histories[key] || [])].slice(0, maxEntries);
    save();
    return entry;
  }

  function list(templateId, agentId) {
    return [...(histories[`${templateId}:${agentId}`] || [])];
  }

  function clear(templateId, agentId) {
    delete histories[`${templateId}:${agentId}`];
    save();
  }

  function removeTemplate(templateId) {
    for (const key of Object.keys(histories)) if (key.startsWith(`${templateId}:`)) delete histories[key];
    save();
  }

  return { load, append, list, clear, removeTemplate };
}

module.exports = {
  DEFAULT_EXCLUDES,
  MAX_OUTPUT_BYTES,
  PROMPT_VARIABLES,
  PROVIDERS,
  createListenerAgentStore,
  normalizeListenerAgent,
  normalizeListenerAgents,
  normalizeTrigger,
  renderPrompt,
  truncateOutput
};
