import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { DEFAULT_WINDOW_MS, createTemplateUsageStore } = require("./template-usage-store.cjs");

function createUsageFile() {
  return path.join(mkdtempSync(path.join(tmpdir(), "pannel-handle-template-usage-")), "template-usage.json");
}

describe("template usage store", () => {
  it("loads only launches inside the rolling window", () => {
    const usageFile = createUsageFile();
    const currentTime = 2_000_000_000_000;
    writeFileSync(usageFile, JSON.stringify({
      recent: [currentTime - DEFAULT_WINDOW_MS, currentTime - 1_000],
      expired: [currentTime - DEFAULT_WINDOW_MS - 1],
      future: [currentTime + 1]
    }));
    const store = createTemplateUsageStore({ usageFile, now: () => currentTime });

    store.load();

    expect(store.getSummary("recent")).toEqual({
      recentLaunchCount: 2,
      lastLaunchedAt: currentTime - 1_000
    });
    expect(store.getSummary("expired")).toEqual({ recentLaunchCount: 0, lastLaunchedAt: undefined });
    expect(store.getSummary("future")).toEqual({ recentLaunchCount: 0, lastLaunchedAt: undefined });
    expect(JSON.parse(readFileSync(usageFile, "utf-8"))).toEqual({
      recent: [currentTime - DEFAULT_WINDOW_MS, currentTime - 1_000]
    });
  });

  it("records successful launches atomically and removes deleted templates", () => {
    const usageFile = createUsageFile();
    let currentTime = 1_000;
    const store = createTemplateUsageStore({ usageFile, now: () => currentTime, windowMs: 500 });
    store.load();

    store.record("template-1");
    currentTime = 1_200;
    store.record("template-1");

    expect(store.getSummary("template-1")).toEqual({ recentLaunchCount: 2, lastLaunchedAt: 1_200 });
    expect(JSON.parse(readFileSync(usageFile, "utf-8"))).toEqual({ "template-1": [1_000, 1_200] });

    store.remove("template-1");
    expect(store.getSummary("template-1")).toEqual({ recentLaunchCount: 0, lastLaunchedAt: undefined });
    expect(JSON.parse(readFileSync(usageFile, "utf-8"))).toEqual({});
  });
});
