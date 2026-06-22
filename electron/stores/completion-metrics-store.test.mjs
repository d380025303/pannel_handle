import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createCompletionMetricsStore } = require("./completion-metrics-store.cjs");
const tempDirs = [];

function createStore(now = () => Date.UTC(2026, 5, 22)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-completion-metrics-"));
  tempDirs.push(dir);
  const metricsFile = path.join(dir, "completion-metrics.json");
  const logger = { error: vi.fn() };
  const store = createCompletionMetricsStore({ metricsFile, now, logger });
  store.load();
  return { store, metricsFile, logger };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("completion-metrics-store", () => {
  it("persists aggregate counters without completion content", () => {
    const { store, metricsFile } = createStore();
    store.recordEvent({ mode: "agent", source: "model", event: "shown", latencyMs: 800, draft: "private" });
    store.recordEvent({ mode: "agent", source: "model", event: "accepted", completion: "secret" });
    store.recordEvent({ mode: "agent", source: "model", event: "submitted_after_accept", editDistance: 0, finalLength: 42 });
    store.recordError("shell", "model");

    const raw = fs.readFileSync(metricsFile, "utf-8");
    const totals = store.getMetrics().totals;
    expect(raw).not.toContain("private");
    expect(raw).not.toContain("secret");
    expect(totals.agent.model).toMatchObject({ shown: 1, accepted: 1, submittedAfterAccept: 1, zeroEditSubmissions: 1 });
    expect(totals.agent.model.latencyBuckets.lt1000).toBe(1);
    expect(totals.shell.model.errors).toBe(1);
  });

  it("reloads, clears, and recovers from a corrupt file", () => {
    const { store, metricsFile, logger } = createStore();
    store.recordEvent({ mode: "shell", source: "history", event: "shown", latencyMs: 0 });
    const reloaded = createCompletionMetricsStore({ metricsFile, now: () => Date.UTC(2026, 5, 22), logger });
    reloaded.load();
    expect(reloaded.getMetrics().totals.shell.history.shown).toBe(1);
    expect(reloaded.clear().totals.shell.history.shown).toBe(0);

    fs.writeFileSync(metricsFile, "not-json", "utf-8");
    reloaded.load();
    expect(reloaded.getMetrics().totals.shell.history.shown).toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });

  it("retains only the latest thirty calendar days", () => {
    let timestamp = Date.UTC(2026, 4, 1);
    const { store } = createStore(() => timestamp);
    store.recordEvent({ mode: "agent", source: "model", event: "shown" });
    timestamp = Date.UTC(2026, 5, 22);
    store.recordEvent({ mode: "agent", source: "model", event: "shown" });
    expect(Object.keys(store.getMetrics().days)).toEqual(["2026-06-22"]);
    expect(store.getMetrics().totals.agent.model.shown).toBe(2);
  });
});
