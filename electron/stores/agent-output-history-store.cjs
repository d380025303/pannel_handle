const fs = require("node:fs");
const crypto = require("node:crypto");
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

function getArchiveKey(session) {
  if (session.templateId) {
    return `terminal:${session.templateId}`;
  }
  const cwd = String(session.cwd || "").trim().replace(/\\/g, "/").toLowerCase();
  if (!cwd) {
    return `terminal:${session.id}`;
  }
  const projectHash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 20);
  return `ephemeral:${session.agentProvider}:${projectHash}`;
}

function cloneEntry(entry) {
  return {
    ...entry,
    responses: Array.isArray(entry.responses) ? entry.responses.map(response => ({ ...response })) : []
  };
}

function toPublicRun(entry) {
  return {
    id: entry.id,
    templateId: entry.templateId || undefined,
    provider: entry.provider,
    title: entry.title,
    cwd: entry.cwd,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    exitCode: entry.exitCode,
    responsesTruncated: entry.responsesTruncated === true,
    responses: Array.isArray(entry.responses) ? entry.responses.map(({ dedupeKey: _dedupeKey, ...response }) => ({ ...response })) : []
  };
}

function createAgentOutputHistoryStore({
  historyFile,
  getPolicy = () => ({}),
  now = () => Date.now(),
  onChanged = () => {}
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

  function notifyChanged(sessionId) {
    try {
      onChanged({ sessionId, timestamp: now() });
    } catch (err) {
      console.error("Failed to notify Agent output history change:", err);
    }
  }

  function storeEntry(active) {
    const existing = Array.isArray(histories[active.key]) ? histories[active.key] : [];
    histories[active.key] = [cloneEntry(active.entry), ...existing.filter(item => item?.id !== active.entry.id)]
      .slice(0, active.policy.maxEntries);
    dirty = true;
  }

  function start(session) {
    if (!session?.agentProvider) return undefined;
    const policy = normalizePolicy(getPolicy());
    const key = getArchiveKey(session);
    const entry = {
      id: session.id,
      templateId: session.templateId || undefined,
      provider: session.agentProvider,
      title: session.title,
      cwd: session.cwd,
      startedAt: session.createdAt || now(),
      finishedAt: null,
      exitCode: null,
      output: "",
      truncated: false,
      responses: [],
      responsesTruncated: false
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

  function recordResponse(session, response = {}) {
    if (!session?.id || !session.agentProvider) return undefined;
    let active = activeRuns.get(session.id);
    if (!active) {
      start(session);
      active = activeRuns.get(session.id);
    }
    if (!active) return undefined;

    const content = String(response.content || "").trim();
    if (!content) return undefined;
    const createdAt = Number.isFinite(response.createdAt) ? response.createdAt : now();
    const dedupeKey = typeof response.dedupeKey === "string" && response.dedupeKey.trim()
      ? response.dedupeKey.trim()
      : undefined;
    const limited = truncateUtf8(content, active.policy.maxOutputBytes);
    const item = {
      id: String(response.id || dedupeKey || `${session.id}:${createdAt}:${active.entry.responses.length}`),
      createdAt,
      content: limited.value,
      truncated: limited.truncated,
      ...(dedupeKey ? { dedupeKey } : {})
    };
    const existingIndex = dedupeKey
      ? active.entry.responses.findIndex(current => current.dedupeKey === dedupeKey)
      : -1;
    if (existingIndex >= 0) {
      active.entry.responses[existingIndex] = item;
    } else {
      active.entry.responses.push(item);
    }

    let totalBytes = active.entry.responses.reduce((total, current) => (
      total + Buffer.byteLength(current.content, "utf-8")
    ), 0);
    while (totalBytes > active.policy.maxOutputBytes && active.entry.responses.length > 1) {
      const removed = active.entry.responses.shift();
      totalBytes -= Buffer.byteLength(removed.content, "utf-8");
      active.entry.responsesTruncated = true;
    }
    if (limited.truncated) active.entry.responsesTruncated = true;

    storeEntry(active);
    flush();
    notifyChanged(session.id);
    return { ...item, dedupeKey: undefined };
  }

  function finish(sessionId, { exitCode = null } = {}) {
    const active = activeRuns.get(sessionId);
    if (!active) return;
    active.entry.finishedAt = now();
    active.entry.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    storeEntry(active);
    activeRuns.delete(sessionId);
    flush();
    notifyChanged(sessionId);
  }

  function list(templateId) {
    const entries = histories[`terminal:${templateId}`];
    return Array.isArray(entries) ? entries.map(entry => ({ ...entry })) : [];
  }

  function listResponses({ scope = "all", sessionId, offset = 0, limit = 50 } = {}) {
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeLimit = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)));
    if (scope === "current") {
      const active = activeRuns.get(sessionId);
      if (active) {
        return { runs: [toPublicRun(active.entry)], total: 1 };
      }
      for (const entries of Object.values(histories)) {
        const entry = Array.isArray(entries) ? entries.find(item => item?.id === sessionId) : undefined;
        if (entry) return { runs: [toPublicRun(entry)], total: 1 };
      }
      return { runs: [], total: 0 };
    }

    const entriesById = new Map();
    for (const entries of Object.values(histories)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry?.id && Array.isArray(entry.responses) && entry.responses.length > 0) {
          entriesById.set(entry.id, entry);
        }
      }
    }
    for (const active of activeRuns.values()) {
      if (active.entry.responses.length > 0) entriesById.set(active.entry.id, active.entry);
    }
    const all = [...entriesById.values()].sort((left, right) => {
      const leftTime = left.responses?.at(-1)?.createdAt || left.startedAt || 0;
      const rightTime = right.responses?.at(-1)?.createdAt || right.startedAt || 0;
      return rightTime - leftTime;
    });
    return {
      runs: all.slice(safeOffset, safeOffset + safeLimit).map(toPublicRun),
      total: all.length
    };
  }

  function hasAnyResponses() {
    return listResponses({ scope: "all", limit: 1 }).total > 0;
  }

  function shutdown() {
    for (const sessionId of [...activeRuns.keys()]) finish(sessionId);
    flush();
  }

  return { load, start, appendOutput, recordResponse, finish, list, listResponses, hasAnyResponses, flush, shutdown };
}

module.exports = { createAgentOutputHistoryStore, getArchiveKey, normalizePolicy, truncateUtf8 };
