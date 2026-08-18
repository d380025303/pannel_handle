import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("persists structured responses immediately and exposes the active run", () => {
    const onChanged = vi.fn();
    const { store, historyFile } = createStore({
      getPolicy: () => ({ maxEntries: 10, maxOutputBytes: 16 * 1024 }),
      now: () => 300,
      onChanged
    });
    store.load();
    const session = {
      id: "run-1",
      templateId: "template-1",
      title: "Codex",
      cwd: "C:\\work",
      agentProvider: "codex",
      createdAt: 100
    };
    store.start(session);

    store.recordResponse(session, {
      id: "turn-1",
      dedupeKey: "codex:agent-1:turn-1",
      content: "第一条最终答复",
      phase: "final",
      createdAt: 200
    });

    expect(store.listResponses({ scope: "current", sessionId: "run-1" })).toEqual({
      total: 1,
      runs: [expect.objectContaining({
        id: "run-1",
        templateId: "template-1",
        responses: [{ id: "turn-1", content: "第一条最终答复", phase: "final", createdAt: 200, truncated: false }]
      })]
    });
    expect(JSON.parse(fs.readFileSync(historyFile, "utf-8"))["terminal:template-1"][0].responses).toHaveLength(1);
    expect(onChanged).toHaveBeenCalledWith({ sessionId: "run-1", templateId: "template-1", timestamp: 300 });
  });

  it("deduplicates stable turns and lists closed ephemeral runs globally", () => {
    const { store } = createStore({
      getPolicy: () => ({ maxEntries: 10, maxOutputBytes: 16 * 1024 })
    });
    store.load();
    const session = { id: "quick-1", title: "Codex", cwd: "C:\\work", agentProvider: "codex" };
    store.start(session);
    store.recordResponse(session, { dedupeKey: "codex:agent-1:turn-1", content: "旧内容" });
    store.recordResponse(session, { dedupeKey: "codex:agent-1:turn-1", content: "更新内容" });
    store.finish(session.id);

    const result = store.listResponses({ scope: "all" });
    expect(result.total).toBe(1);
    expect(result.runs[0]).toEqual(expect.objectContaining({
      id: "quick-1",
      templateId: undefined,
      responses: [expect.objectContaining({ content: "更新内容" })]
    }));
  });

  it("keeps the newest responses inside the configured byte limit", () => {
    const { store } = createStore({
      getPolicy: () => ({ maxEntries: 10, maxOutputBytes: 16 * 1024 })
    });
    store.load();
    const session = { id: "run-1", title: "Agent", agentProvider: "qoder" };
    store.start(session);
    store.recordResponse(session, { id: "first", content: "a".repeat(10 * 1024) });
    store.recordResponse(session, { id: "second", content: "b".repeat(10 * 1024) });

    const [run] = store.listResponses({ scope: "current", sessionId: session.id }).runs;
    expect(run.responses.map(response => response.id)).toEqual(["second"]);
    expect(run.responsesTruncated).toBe(true);
  });

  it("shares current history across running instances of the same template", () => {
    const onChanged = vi.fn();
    const { store } = createStore({ onChanged, now: () => 500 });
    store.load();
    const first = { id: "run-1", templateId: "template-1", title: "Agent", agentProvider: "codex" };
    const second = { id: "run-2", templateId: "template-1", title: "Agent", agentProvider: "codex" };
    store.start(first);
    store.recordResponse(first, { id: "plan", phase: "commentary", content: "先检查实现", createdAt: 100 });
    store.finish(first.id);
    store.start(second);
    store.recordResponse(second, { id: "answer", phase: "final", content: "已完成", createdAt: 200 });

    const result = store.listResponses({
      scope: "current",
      sessionId: second.id,
      templateId: "template-1"
    });
    expect(result.total).toBe(2);
    expect(result.runs.map(run => run.id)).toEqual(["run-2", "run-1"]);
    expect(result.runs[1].responses[0]).toEqual(expect.objectContaining({ phase: "commentary", content: "先检查实现" }));
    expect(onChanged).toHaveBeenCalledWith({ sessionId: "run-2", templateId: "template-1", timestamp: 500 });
  });

  it("treats legacy responses without a phase as final", () => {
    const { store, historyFile } = createStore();
    fs.writeFileSync(historyFile, JSON.stringify({
      "terminal:template-1": [{
        id: "run-1",
        templateId: "template-1",
        provider: "codex",
        title: "Agent",
        startedAt: 100,
        responses: [{ id: "old", createdAt: 200, content: "旧答复", truncated: false }]
      }]
    }), "utf-8");
    store.load();

    const [run] = store.listResponses({ scope: "current", templateId: "template-1" }).runs;
    expect(run.responses[0].phase).toBe("final");
  });
});
