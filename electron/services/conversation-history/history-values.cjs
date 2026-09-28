const { MAX_LIMIT } = require("./history-limits.cjs");

function clampLimit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed)));
}

function parseCursor(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (!/^\d+$/.test(String(value))) throw new Error("Invalid Agent conversation history cursor.");
  return Number(value);
}

function normalizeCwd(value, windows = false) {
  let normalized = String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.startsWith("//?/")) normalized = normalized.slice(4);
  if (windows) normalized = normalized.toLowerCase();
  return normalized;
}

function timestampMs(value) {
  const number = Number(value);
  if (Number.isFinite(number)) return number > 0 && number < 10_000_000_000 ? number * 1000 : number;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readJsonLines(text, visit) {
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      visit(JSON.parse(line));
    } catch {
      // Ignore a partially written or obsolete line while the provider owns the file.
    }
  }
}

function filterAndPage(items, { query, cursor, limit }) {
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  const filtered = normalizedQuery
    ? items.filter(item => [item.title, item.preview, item.cwd].some(value => String(value || "").toLocaleLowerCase().includes(normalizedQuery)))
    : items;
  filtered.sort((left, right) => right.updatedAt - left.updatedAt || left.ref.localeCompare(right.ref));
  const offset = parseCursor(cursor);
  const page = filtered.slice(offset, offset + limit);
  return {
    items: page,
    nextCursor: offset + page.length < filtered.length ? String(offset + page.length) : null
  };
}

function parseConversationRef(value) {
  const match = /^(codex|codebuddy|opencode|gemini|grok):([A-Za-z0-9][A-Za-z0-9:_.-]{0,299})$/.exec(String(value || ""));
  if (!match) throw new Error("Invalid Agent conversation reference.");
  return { provider: match[1], id: match[2] };
}

function pageMessages(messages, cursor, limit) {
  const newestFirst = [...messages].sort((left, right) => right.timestamp - left.timestamp);
  const offset = parseCursor(cursor);
  const page = newestFirst.slice(offset, offset + limit);
  return {
    messages: page,
    nextCursor: offset + page.length < newestFirst.length ? String(offset + page.length) : null
  };
}

module.exports = {
  clampLimit,
  parseCursor,
  normalizeCwd,
  timestampMs,
  readJsonLines,
  filterAndPage,
  parseConversationRef,
  pageMessages
};
