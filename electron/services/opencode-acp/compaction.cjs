function applyCompaction(items, update, turnId) {
  const marker = update.sessionUpdate === "session_info_update" ? update._meta?.["opencode/compaction"] : null;
  if (!marker && !["compaction_update", "compaction_summary_chunk"].includes(update.sessionUpdate)) return false;
  const source = marker || update;
  const id = marker ? source.messageId : source.compactionId;
  if (typeof id !== "string" || !id) return true;
  const child = update._meta?.["opencode/child-session"];
  const childId = typeof child?.id === "string" ? child.id : "";
  const key = `opencode-compaction:${JSON.stringify([childId, id])}`;
  let item = items.find(value => value.id === key);
  if (update.sessionUpdate === "compaction_summary_chunk") {
    if (item?.status === "in_progress" && update.content && typeof update.content === "object")
      item.compactionSummary = [...(item.compactionSummary || []), update.content];
    return true;
  }
  if (typeof source.status !== "string") return true;
  if (!item) {
    item = { id: key, type: "contextCompaction", compactionId: id, turnId,
      ...(childId ? { compactionSource: typeof child.title === "string" ? child.title : childId } : {}) };
    items.push(item);
  }
  item.status = source.status === "started" ? "in_progress" : source.status;
  if (Object.hasOwn(source, "summary")) item.compactionSummary = Array.isArray(source.summary) ? source.summary : [];
  if (Object.hasOwn(source, "error")) item.compactionError = typeof source.error === "string" ? source.error
    : typeof source.error?.message === "string" ? source.error.message : undefined;
  return true;
}

function interruptCompactions(items) {
  for (const item of items) if (item.type === "contextCompaction" && item.compactionId && item.status === "in_progress")
    item.status = "unknown";
}

module.exports = { applyCompaction, interruptCompactions };
