const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runCodeBuddyUserInfoRequest } = require("./codebuddy-user-info-client.cjs");
const { createWorkBuddyAcpTransport } = require("./workbuddy-checkin-service.cjs");

const MAX_CACHE_FILE_BYTES = 1024 * 1024;
const USER_INFO_TIMEOUT_MS = 15 * 1000;
const USER_INFO_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_MODEL_CONTEXT_WINDOW = 1_000_000;

function normalizeText(value, maxLength = 500) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeTokenLimit(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1024 && number <= MAX_MODEL_CONTEXT_WINDOW
    ? number
    : undefined;
}

function normalizeClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(normalizeText(value, 5));
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? `${hour}:${String(minute).padStart(2, "0")}` : "";
}

function normalizePromotion(promotion) {
  const id = normalizeText(promotion?.id, 120);
  const label = normalizeText(promotion?.badge?.label, 40);
  if (!id || !label || promotion?.enabled === false) return null;
  const color = normalizeText(promotion?.badge?.color, 20);
  const daily = Array.isArray(promotion?.schedule?.daily)
    ? promotion.schedule.daily.map(window => ({ start: normalizeClock(window?.start), end: normalizeClock(window?.end) })).filter(window => window.start && window.end)
    : [];
  return {
    id,
    priority: Number.isFinite(promotion?.priority) ? promotion.priority : 0,
    badge: {
      label,
      ...(promotion?.badge?.display === "always" ? { display: "always" } : {}),
      ...(/^#[0-9a-f]{6}$/i.test(color) ? { color } : {})
    },
    hover: {
      ...(normalizeText(promotion?.hover?.textZh) ? { textZh: normalizeText(promotion.hover.textZh) } : {}),
      ...(normalizeText(promotion?.hover?.textEn) ? { textEn: normalizeText(promotion.hover.textEn) } : {})
    },
    schedule: {
      ...(normalizeText(promotion?.schedule?.timezone, 80) ? { timezone: normalizeText(promotion.schedule.timezone, 80) } : {}),
      ...(normalizeText(promotion?.schedule?.validFrom, 80) ? { validFrom: normalizeText(promotion.schedule.validFrom, 80) } : {}),
      ...(normalizeText(promotion?.schedule?.validUntil, 80) ? { validUntil: normalizeText(promotion.schedule.validUntil, 80) } : {}),
      ...(daily.length ? { daily } : {})
    }
  };
}

function normalizeCatalogData(data) {
  if (!Array.isArray(data?.models)) return [];
  const promotions = Array.isArray(data.modelPromotions) ? data.modelPromotions : [];
  return data.models.map(model => {
    const id = normalizeText(model?.id, 120);
    if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return null;
    const contextLimits = [normalizeTokenLimit(model?.maxInputTokens), normalizeTokenLimit(model?.maxAllowedSize)].filter(Boolean);
    const contextWindow = contextLimits.length ? Math.min(...contextLimits) : undefined;
    const sourcePromotions = Array.isArray(model?.promotions)
      ? model.promotions
      : promotions.filter(promotion => Array.isArray(promotion?.modelIds) && promotion.modelIds.includes(id));
    return {
      id,
      name: normalizeText(model?.name, 120) || id,
      ...(contextWindow ? { contextWindow } : {}),
      promotions: sourcePromotions.map(normalizePromotion).filter(Boolean)
    };
  }).filter(Boolean);
}

function selectCachedCatalog(rows, userId) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => String(row?.userId || "") === userId && Array.isArray(row?.data?.models))
    .sort((left, right) => Number(right?.ts || 0) - Number(left?.ts || 0))[0];
}

function clockMinutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function zonedMinutes(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || undefined,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    return Number(parts.find(part => part.type === "hour")?.value) * 60
      + Number(parts.find(part => part.type === "minute")?.value);
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}

function isPromotionActive(promotion, timestamp = Date.now()) {
  const schedule = promotion?.schedule || {};
  const validFrom = Date.parse(schedule.validFrom || "");
  const validUntil = Date.parse(schedule.validUntil || "");
  if (Number.isFinite(validFrom) && timestamp < validFrom) return false;
  if (Number.isFinite(validUntil) && timestamp >= validUntil) return false;
  if (!Array.isArray(schedule.daily) || !schedule.daily.length) return true;
  const minute = zonedMinutes(new Date(timestamp), schedule.timezone);
  return schedule.daily.some(window => {
    const start = clockMinutes(window.start);
    const end = clockMinutes(window.end);
    if (start === end) return true;
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  });
}

function getPromotionDisplay(promotions, timestamp = Date.now()) {
  const sorted = (Array.isArray(promotions) ? promotions : []).slice().sort((left, right) => right.priority - left.priority);
  const selected = sorted.find(promotion => isPromotionActive(promotion, timestamp))
    || sorted.find(promotion => promotion?.badge?.display === "always");
  if (!selected) return [];
  return [{
    id: selected.id,
    label: selected.badge.label,
    ...(selected.badge.color ? { color: selected.badge.color } : {}),
    ...(selected.hover?.textZh ? { descriptionZh: selected.hover.textZh } : {}),
    ...(selected.hover?.textEn ? { descriptionEn: selected.hover.textEn } : {})
  }];
}

function createWorkBuddyModelCatalogService({
  cacheDirectory = path.join(os.homedir(), ".workbuddy", "local_storage"),
  transportFactory = () => createWorkBuddyAcpTransport(),
  readUserInfo = transport => runCodeBuddyUserInfoRequest(transport, {
    timeoutMs: USER_INFO_TIMEOUT_MS,
    maxOutputBytes: USER_INFO_MAX_OUTPUT_BYTES
  }),
  fsPromises = fs.promises
} = {}) {
  async function readCatalog() {
    const { userId } = await readUserInfo(transportFactory());
    const normalizedUserId = normalizeText(userId, 200);
    if (!normalizedUserId) throw new Error("WorkBuddy 未返回当前用户标识。");
    const entries = await fsPromises.readdir(cacheDirectory, { withFileTypes: true });
    let selected;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".info")) continue;
      const cacheFile = path.join(cacheDirectory, entry.name);
      try {
        const stats = await fsPromises.stat(cacheFile);
        if (stats.size > MAX_CACHE_FILE_BYTES) continue;
        const row = selectCachedCatalog(JSON.parse(await fsPromises.readFile(cacheFile, "utf-8")), normalizedUserId);
        if (row && (!selected || Number(row.ts || 0) > Number(selected.ts || 0))) selected = row;
      } catch { /* Ignore unrelated or partially written WorkBuddy cache files. */ }
    }
    if (!selected) throw new Error("未找到当前 WorkBuddy 用户的模型目录缓存。");
    return normalizeCatalogData(selected.data);
  }

  return { readCatalog };
}

module.exports = {
  createWorkBuddyModelCatalogService,
  getPromotionDisplay,
  isPromotionActive,
  normalizeCatalogData,
  normalizeTokenLimit,
  normalizePromotion,
  selectCachedCatalog
};
