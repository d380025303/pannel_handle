const { normalizeText, normalizeTokenLimit, normalizePromotion, normalizeCatalogData, selectCachedCatalog, isPromotionActive, getPromotionDisplay } = require("./model-catalog-values.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runCodeBuddyUserInfoRequest } = require("./codebuddy-user-info-client.cjs");
const { createWorkBuddyAcpTransport } = require("./workbuddy-acp-transport.cjs");

const MAX_CACHE_FILE_BYTES = 1024 * 1024;
const USER_INFO_TIMEOUT_MS = 15 * 1000;
const USER_INFO_MAX_OUTPUT_BYTES = 256 * 1024;

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
