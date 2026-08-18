const fs = require("node:fs");

const DEFAULT_MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

function joinTextContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map(item => typeof item === "string" ? item : item?.text)
    .filter(value => typeof value === "string" && value.trim())
    .join("\n")
    .trim();
}

function parseCodexItem(row) {
  if (row?.type !== "response_item") return undefined;
  const payload = row.payload;
  if (payload?.type !== "message" || payload.role !== "assistant") return undefined;
  const content = joinTextContent(payload.content);
  if (!content) return undefined;
  const createdAt = Date.parse(row.timestamp);
  return {
    id: String(payload.id || ""),
    phase: payload.phase === "final" ? "final" : "commentary",
    content,
    ...(Number.isFinite(createdAt) ? { createdAt } : {})
  };
}

function parseClaudeItem(row, defaultPhase) {
  if (row?.type !== "assistant" || row.message?.role !== "assistant") return undefined;
  const content = joinTextContent(row.message.content);
  if (!content) return undefined;
  const createdAt = Date.parse(row.timestamp);
  return {
    id: String(row.message.id || row.uuid || ""),
    phase: defaultPhase,
    content,
    ...(Number.isFinite(createdAt) ? { createdAt } : {})
  };
}

function readTail(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return "";
  const length = Math.min(stat.size, maxBytes);
  const start = stat.size - length;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  let text = buffer.toString("utf-8");
  if (start > 0) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
  }
  return text;
}

function readAgentTranscriptItems(provider, transcriptPath, {
  defaultPhase = "commentary",
  maxBytes = DEFAULT_MAX_TRANSCRIPT_BYTES
} = {}) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim().toLowerCase().endsWith(".jsonl")) return [];
  try {
    const items = [];
    const seen = new Set();
    for (const line of readTail(transcriptPath.trim(), maxBytes).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const item = provider === "codex"
        ? parseCodexItem(row)
        : parseClaudeItem(row, defaultPhase);
      if (!item) continue;
      const id = item.id || `${provider}:${items.length}:${item.content}`;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ ...item, id });
    }
    return items;
  } catch (err) {
    if (err?.code !== "ENOENT") console.error("Failed to read Agent transcript:", err);
    return [];
  }
}

module.exports = { readAgentTranscriptItems, joinTextContent };
