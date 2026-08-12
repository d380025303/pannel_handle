const fs = require("node:fs");
const { StringDecoder } = require("node:string_decoder");
const {
  DEFAULT_AGENT_OUTPUT_HISTORY_MAX_ENTRIES,
  DEFAULT_AGENT_OUTPUT_MAX_BYTES,
  MAX_AGENT_OUTPUT_HISTORY_MAX_ENTRIES,
  MAX_AGENT_OUTPUT_MAX_BYTES,
  MIN_AGENT_OUTPUT_HISTORY_MAX_ENTRIES,
  MIN_AGENT_OUTPUT_MAX_BYTES,
  isIntegerInRange
} = require("./config-store.cjs");

function truncateUtf8(value, maxBytes) {
  const buffer = Buffer.from(String(value || ""), "utf-8");
  if (buffer.length <= maxBytes) {
    return { value: buffer.toString("utf-8"), truncated: false };
  }
  const decoder = new StringDecoder("utf8");
  return { value: decoder.write(buffer.subarray(0, maxBytes)), truncated: true };
}

function normalizePolicy(policy = {}) {
  return {
    maxEntries: isIntegerInRange(
      policy.maxEntries,
      MIN_AGENT_OUTPUT_HISTORY_MAX_ENTRIES,
      MAX_AGENT_OUTPUT_HISTORY_MAX_ENTRIES
    ) ? policy.maxEntries : DEFAULT_AGENT_OUTPUT_HISTORY_MAX_ENTRIES,
    maxOutputBytes: isIntegerInRange(
      policy.maxOutputBytes,
      MIN_AGENT_OUTPUT_MAX_BYTES,
      MAX_AGENT_OUTPUT_MAX_BYTES
    ) ? policy.maxOutputBytes : DEFAULT_AGENT_OUTPUT_MAX_BYTES
  };
}

function createAgentOutputHistoryStore({
  historyFile,
  getPolicy = () => ({}),
  now = () => Date.now()
}) {
  let histories = {};
  let dirty = false;
  const activeRuns = new Map();

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(historyFile, "utf-8"));
      histories = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      if (err.code !== "ENOENT") console.error("Failed to load Agent output history:", err);
      histories = {};
    }
  }

  function save() {
    const tmp = `${historyFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(histories, null, 2), "utf-8");
    fs.renameSync(tmp, historyFile);
    dirty = false;
  }

  function flush() {
    if (dirty) save();
  }

  function start(session) {
    if (!session?.agentProvider) return undefined;
    const policy = normalizePolicy(getPolicy());
    const key = `terminal:${session.templateId || session.id}`;
    const entry = {
      id: session.id,
      templateId: session.templateId || session.id,
      provider: session.agentProvider,
      title: session.title,
      startedAt: session.createdAt || now(),
      finishedAt: null,
      exitCode: null,
      output: "",
      truncated: false
    };
    activeRuns.set(session.id, { entry, key, policy });
    return entry;
  }

  function appendOutput(sessionId, chunk) {
    const active = activeRuns.get(sessionId);
    if (!active || active.entry.truncated) return;
    const output = truncateUtf8(`${active.entry.output}${chunk}`, active.policy.maxOutputBytes);
    active.entry.output = output.value;
    active.entry.truncated = output.truncated;
  }

  function finish(sessionId, { exitCode = null } = {}) {
    const active = activeRuns.get(sessionId);
    if (!active) return;
    active.entry.finishedAt = now();
    active.entry.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    const existing = Array.isArray(histories[active.key]) ? histories[active.key] : [];
    histories[active.key] = [active.entry, ...existing.filter(item => item?.id !== active.entry.id)]
      .slice(0, active.policy.maxEntries);
    activeRuns.delete(sessionId);
    dirty = true;
    flush();
  }

  function list(templateId) {
    const entries = histories[`terminal:${templateId}`];
    return Array.isArray(entries) ? entries.map(entry => ({ ...entry })) : [];
  }

  function shutdown() {
    for (const sessionId of [...activeRuns.keys()]) finish(sessionId);
    flush();
  }

  return { load, start, appendOutput, finish, list, flush, shutdown };
}

module.exports = { createAgentOutputHistoryStore, normalizePolicy, truncateUtf8 };
