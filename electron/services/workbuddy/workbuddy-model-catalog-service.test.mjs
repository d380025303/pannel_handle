import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  createWorkBuddyModelCatalogService,
  getPromotionDisplay,
  isPromotionActive,
  normalizeTokenLimit
} = require("./workbuddy-model-catalog-service.cjs");
const dirs = [];

afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe("WorkBuddy model catalog", () => {
  it("reads the newest cache row for the current ACP user and keeps only display metadata", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pannel-workbuddy-models-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "nested"));
    writeFileSync(path.join(dir, "catalog.info"), JSON.stringify([
      { userId: "other", ts: 999, data: { models: [{ id: "other" }], modelPromotions: [] } },
      { userId: "current", ts: 100, data: { models: [{ id: "hy3", name: "旧名称" }], modelPromotions: [] } },
      {
        userId: "current",
        ts: 200,
        token: "must-not-leak",
        data: {
          models: [{ id: "hy3", name: "混元 3", credits: "0x", maxInputTokens: 1_000_000, maxAllowedSize: 800_000 }],
          modelPromotions: [{ id: "free", enabled: true, priority: 200, modelIds: ["hy3"], badge: { label: "限时免费", color: "#FF0000", display: "activeOnly" }, hover: { textZh: "每日赠送免费额度。" } }]
        }
      }
    ]));
    writeFileSync(path.join(dir, "broken.info"), "not json");
    const service = createWorkBuddyModelCatalogService({
      cacheDirectory: dir,
      transportFactory: () => ({}),
      readUserInfo: async () => ({ userId: "current", token: "secret" })
    });

    expect(await service.readCatalog()).toEqual([{
      id: "hy3",
      name: "混元 3",
      contextWindow: 800_000,
      promotions: [{ id: "free", priority: 200, badge: { label: "限时免费", color: "#FF0000" }, hover: { textZh: "每日赠送免费额度。" }, schedule: {} }]
    }]);
  });

  it("accepts only bounded integer model token limits", () => {
    expect(normalizeTokenLimit("1000000")).toBe(1_000_000);
    expect(normalizeTokenLimit(1023)).toBeUndefined();
    expect(normalizeTokenLimit(1_000_001)).toBeUndefined();
    expect(normalizeTokenLimit(128000.5)).toBeUndefined();
  });

  it("evaluates bounded and cross-midnight schedules in the configured timezone", () => {
    const promotion = {
      id: "night",
      priority: 1,
      badge: { label: "夜间折扣" },
      hover: {},
      schedule: { timezone: "Asia/Shanghai", daily: [{ start: "23:00", end: "7:50" }] }
    };
    expect(isPromotionActive(promotion, Date.parse("2026-09-01T23:30:00+08:00"))).toBe(true);
    expect(isPromotionActive(promotion, Date.parse("2026-09-01T12:00:00+08:00"))).toBe(false);
    expect(getPromotionDisplay([promotion], Date.parse("2026-09-01T23:30:00+08:00"))).toEqual([{ id: "night", label: "夜间折扣" }]);
  });

  it("does not display an expired active-only promotion", () => {
    const promotion = { id: "free", priority: 1, badge: { label: "限时免费" }, hover: {}, schedule: { validUntil: "2026-09-01T00:00:00+08:00" } };
    expect(getPromotionDisplay([promotion], Date.parse("2026-09-01T00:00:00+08:00"))).toEqual([]);
  });
});
