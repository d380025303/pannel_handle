import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createAgentOutputHistoryStore, truncateUtf8 } = require("./agent-output-history-store.cjs");
const tempDirs = [];

function createStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-output-history-"));
  tempDirs.push(dir);
  const historyFile = path.join(dir, "history.json");
  const store = createAgentOutputHistoryStore({ historyFile, ...options });
  return { store, historyFile };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("agent-output-history-store", () => {
  it("truncates without splitting UTF-8 characters", () => {
    expect(truncateUtf8("A你B", 4)).toEqual({ value: "A你", truncated: true });
    expect(truncateUtf8("A你B", 3)).toEqual({ value: "A", truncated: true });
  });

  it("persists only Agent sessions and keeps unknown legacy history", () => {
    const { store, historyFile } = createStore({
      getPolicy: () => ({ maxEntries: 100, maxOutputBytes: 16 * 1024 }),
      now: () => 200
    });
    fs.writeFileSync(historyFile, JSON.stringify({ "legacy:key": [{ id: "old" }] }), "utf-8");
    store.load();

    expect(store.start({ id: "shell", templateId: "shell-template", title: "Shell", createdAt: 100 })).toBeUndefined();
    store.start({ id: "run-1", templateId: "template-1", title: "Codex", agentProvider: "codex", createdAt: 100 });
    store.appendOutput("run-1", "hello");
    store.finish("run-1", { exitCode: 0 });

    expect(store.list("template-1")).toEqual([expect.objectContaining({
      id: "run-1", provider: "codex", output: "hello", finishedAt: 200, exitCode: 0
    })]);
    expect(JSON.parse(fs.readFileSync(historyFile, "utf-8"))["legacy:key"]).toEqual([{ id: "old" }]);
  });

  it("takes a policy snapshot per run and applies the entry limit when the next run starts", () => {
    let policy = { maxEntries: 3, maxOutputBytes: 16 * 1024 };
    const { store } = createStore({ getPolicy: () => policy });
    store.load();

    for (let index = 1; index <= 3; index += 1) {
      store.start({ id: `run-${index}`, templateId: "template-1", title: "Agent", agentProvider: "claude" });
      store.finish(`run-${index}`);
    }
    expect(store.list("template-1")).toHaveLength(3);

    policy = { maxEntries: 2, maxOutputBytes: 16 * 1024 };
    store.start({ id: "run-4", templateId: "template-1", title: "Agent", agentProvider: "claude" });
    store.finish("run-4");
    expect(store.list("template-1").map(entry => entry.id)).toEqual(["run-4", "run-3"]);
  });

  it("uses the output limit captured when the run starts", () => {
    let policy = { maxEntries: 10, maxOutputBytes: 16 * 1024 };
    const { store } = createStore({ getPolicy: () => policy });
    store.load();
    store.start({ id: "run-1", templateId: "template-1", title: "Agent", agentProvider: "qoder" });
    policy = { maxEntries: 10, maxOutputBytes: 32 * 1024 };
    store.appendOutput("run-1", "x".repeat(20 * 1024));
    store.finish("run-1");

    const [run] = store.list("template-1");
    expect(Buffer.byteLength(run.output, "utf-8")).toBe(16 * 1024);
    expect(run.truncated).toBe(true);
  });
});
