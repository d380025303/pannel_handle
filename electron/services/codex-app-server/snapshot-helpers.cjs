const path = require("node:path");
const SUMMARY_LIMIT = 500;

function displayItem(item) {
  if (item?.type === "dynamicToolCall") return { ...item,
    output: (item.contentItems || []).filter(part => part.type === "inputText").map(part => part.text).join("\n") };
  if (item?.type !== "userMessage") return item;
  const attachments = [];
  const parts = [];
  const text = item.content?.map(part => {
    if (part.type === "localImage" && typeof part.path === "string") {
      attachments.push({ path: part.path, name: path.basename(part.path) });
      parts.push({ type: "image", path: part.path, name: path.basename(part.path) });
      return "";
    }
    if (part.type === "image") { parts.push({ type: "text", text: "[图片]" }); return "[图片]"; }
    if (part.type !== "text") return "";
    const raw = String(part.text || "");
    const marker = "请读取以下附件文件：";
    const position = raw.lastIndexOf(marker);
    if (position < 0 || (position > 0 && raw.slice(position - 2, position) !== "\n\n")) {
      if (raw) parts.push({ type: "text", text: raw });
      return raw;
    }
    const references = raw.slice(position + marker.length);
    const matches = [...references.matchAll(/"(?:\\.|[^"\\])*"/g)];
    if (!matches.length || matches.map(match => match[0]).join("、") !== references) {
      parts.push({ type: "text", text: raw });
      return raw;
    }
    try {
      for (const match of matches) {
        const filePath = JSON.parse(match[0]);
        if (typeof filePath !== "string") { parts.push({ type: "text", text: raw }); return raw; }
        attachments.push({ path: filePath, name: path.basename(filePath) });
      }
      const cleaned = raw.slice(0, position).trimEnd();
      if (cleaned) parts.push({ type: "text", text: cleaned });
      return cleaned;
    } catch { parts.push({ type: "text", text: raw }); return raw; }
  }).filter(Boolean).join("\n");
  return { ...item, text: Array.isArray(item.content) ? (parts.some(part => part.type === "image")
    ? parts.filter(part => part.type === "text").map(part => part.text).join("") : text) : item.text || "", attachments,
    ...(Array.isArray(item.content) ? { parts } : {}) };
}

function historyItems(thread) {
  return (thread?.turns || []).flatMap(turn => (turn.items || []).map(item => ({ ...displayItem(item),
    ...(item.type === "enteredReviewMode" ? { id: `${item.id}:enteredReviewMode` } : {}),
    ...(["sleep", "imageGeneration"].includes(item.type) && !item.status
      ? { status: turn.status || "completed" } : {}),
    ...(item.type === "contextCompaction" ? { status: "completed" } : {}),
    ...(item.type === "reasoning" ? { status: turn.status === "inProgress" ? "inProgress" : turn.status || "completed" } : {}),
    ...(turn.id ? { turnId: turn.id } : {}) }))).filter(item => item?.id);
}

function mergeQuestionAnswers(items, records) {
  const merged = [...items];
  for (const record of records) {
    const item = record.item;
    if (merged.some(existing => existing.id === item.id)) continue;
    let index = merged.findIndex(existing => existing.id === record.afterItemId);
    if (index < 0) index = merged.findLastIndex(existing => existing.turnId === record.turnId && existing.type === "userMessage");
    if (index < 0) index = merged.findLastIndex(existing => existing.turnId === record.turnId);
    if (index < 0) index = merged.length - 1;
    while (merged[index + 1]?.type === "questionAnswer" && merged[index + 1].afterItemId === record.afterItemId) index += 1;
    merged.splice(index + 1, 0, item);
  }
  return merged;
}

function questionAnswerItem(question, answers, afterItemId) {
  const { turnId, questions } = question.params;
  return {
    id: `question-answer:${turnId}:${question.requestId}`, type: "questionAnswer", turnId,
    afterItemId, status: "submitted",
    questions: questions.map(prompt => ({
      id: prompt.id, header: prompt.header, question: prompt.question,
      answers: prompt.isSecret ? ["••••••"] : [...answers[prompt.id].answers]
    }))
  };
}

function activitySummary(value, recent = false) {
  const text = String(value || "").replace(/<\/?proposed_plan>/gi, "").replace(/\s+/g, " ").trim();
  if (text.length <= SUMMARY_LIMIT) return text;
  return recent ? `…${text.slice(-(SUMMARY_LIMIT - 1))}` : `${text.slice(0, SUMMARY_LIMIT - 1)}…`;
}

function itemSummary(item) {
  if (item?.type === "agentMessage" || item?.type === "plan") return activitySummary(item.text, true);
  if (item?.type === "userMessage") return activitySummary(item.text);
  if (item?.type === "commandExecution") return activitySummary(`执行命令：${item.command || "命令"}`);
  if (item?.type === "fileChange") return "修改文件";
  if (item?.type === "turnPlan") {
    const step = item.plan?.find(value => value.status === "inProgress")
      || item.plan?.find(value => value.status === "pending") || item.plan?.at(-1);
    return activitySummary(step?.step || item.explanation);
  }
  return "";
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function tokenBreakdown(value) {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.inputTokens)
    || !Number.isSafeInteger(value.outputTokens)) return null;
  return {
    inputTokens: tokenCount(value.inputTokens), cachedInputTokens: tokenCount(value.cachedInputTokens),
    cacheWriteInputTokens: tokenCount(value.cacheWriteInputTokens), outputTokens: tokenCount(value.outputTokens),
    reasoningOutputTokens: tokenCount(value.reasoningOutputTokens), totalTokens: tokenCount(value.totalTokens)
  };
}

function updateTokenUsage(entry, params) {
  const total = tokenBreakdown(params.tokenUsage?.total);
  const last = tokenBreakdown(params.tokenUsage?.last);
  if (!total || !last) return false;
  const previousOutput = entry.tokenUsage?.total.outputTokens;
  const previousAt = entry.tokenUpdatedAt;
  const updatedAt = Date.now();
  if (previousOutput != null && total.outputTokens > previousOutput && previousAt != null && updatedAt > previousAt) {
    entry.outputTokensPerSecond = Math.round((total.outputTokens - previousOutput) * 10000 / (updatedAt - previousAt)) / 10;
    entry.outputRateAvailable = true;
  }
  entry.tokenUsage = { total, last, modelContextWindow: params.tokenUsage.modelContextWindow ?? null };
  entry.tokenUpdatedAt = updatedAt;
  entry.turnOutputTokens = Math.max(0, total.outputTokens - entry.turnOutputBaseline);
  return true;
}

module.exports = { displayItem, historyItems, mergeQuestionAnswers, questionAnswerItem, activitySummary, itemSummary, updateTokenUsage };
