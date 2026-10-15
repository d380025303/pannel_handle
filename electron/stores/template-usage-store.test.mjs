import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { DEFAULT_WINDOW_MS, createTemplateUsageStore } = require("./template-usage-store.cjs");

function createUsageFile() {
  return path.join(mkdtempSync(path.join(tmpdir(), "pannel-handle-template-usage-")), "template-usage.json");
}

describe("template usage store", () => {
  it("propagates failed writes without changing memory and persists a successful retry", () => {
    let persisted = { demo: [900] };
    const failure = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    const dataStore = {
      read: () => structuredClone(persisted),
      write: vi.fn(() => { throw failure; })
    };
    const createStore = () => createTemplateUsageStore({ usageFile: "template-usage.json", dataStore, now: () => 1000 });
    const store = createStore();
    store.load();

    let received;
    try { store.record("demo"); } catch (error) { received = error; }
    expect(received).toMatchObject({ message: expect.stringContaining("模板使用记录保存失败"), code: "SQLITE_FULL", cause: failure });
    expect(store.getSummary("demo")).toEqual({ recentLaunchCount: 1, lastLaunchedAt: 900 });
    expect(persisted).toEqual({ demo: [900] });
    const afterFailure = createStore();
    afterFailure.load();
    expect(afterFailure.getSummary("demo")).toEqual(store.getSummary("demo"));

    dataStore.write.mockImplementation((_file, value) => { persisted = structuredClone(value); });
    store.record("demo");
    expect(store.getSummary("demo")).toEqual({ recentLaunchCount: 2, lastLaunchedAt: 1000 });
    const afterSuccess = createStore();
    afterSuccess.load();
    expect(afterSuccess.getSummary("demo")).toEqual(store.getSummary("demo"));
    expect(persisted).toEqual({ demo: [900, 1000] });
  });

  it("filters summaries without writes and prunes all histories on record", () => {
    let currentTime = 1000;
    let persisted = { a: [500, 900], b: [500], untouched: [500] };
    const dataStore = {
      read: () => structuredClone(persisted),
      write: vi.fn((_file, value) => { persisted = structuredClone(value); })
    };
    const now = vi.fn(() => currentTime);
    const store = createTemplateUsageStore({ usageFile: "template-usage.json", dataStore, now, windowMs: 500 });
    store.load();
    currentTime++;
    now.mockClear();

    expect(store.getSummaries([" a ", "b", "a", "missing"])).toEqual(new Map([
      ["a", { recentLaunchCount: 1, lastLaunchedAt: 900 }],
      ["b", { recentLaunchCount: 0, lastLaunchedAt: undefined }],
      ["missing", { recentLaunchCount: 0, lastLaunchedAt: undefined }]
    ]));
    expect(now).toHaveBeenCalledTimes(1);
    expect(dataStore.write).not.toHaveBeenCalled();
    expect(persisted).toEqual({ a: [500, 900], b: [500], untouched: [500] });
    store.getSummaries([]);
    store.getSummaries(["a", "b", "missing"]);
    expect(store.getSummary("untouched")).toEqual({ recentLaunchCount: 0, lastLaunchedAt: undefined });
    expect(dataStore.write).not.toHaveBeenCalled();
    store.record("new");
    expect(dataStore.write).toHaveBeenCalledTimes(1);
    expect(persisted).toEqual({ a: [900], new: [1001] });
  });

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
