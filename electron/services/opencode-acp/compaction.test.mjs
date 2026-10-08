import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
const require = createRequire(import.meta.url);
const { applyCompaction, interruptCompactions } = require("./compaction.cjs");
const patch = (items, data) => applyCompaction(items, { sessionUpdate: "compaction_update", compactionId: "c", ...data }, "turn");

it("projects live and replayed compactions to mobile and rejects stale session updates", async () => {
  const { createOpenCodeAcpSessionService } = require("./session-service.cjs");
  const { toMobileGraphicalSnapshot } = require("../mobile-remote/mobile-graphical-snapshot.cjs");
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
  const emit = value => child.stdout.write(`${JSON.stringify(value)}\n`);
  const update = (sessionId, data) => emit({ method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "c", ...data } } });
  child.stdin.on("data", chunk => {
    const message = JSON.parse(String(chunk));
    if (message.method === "initialize") {
      expect(message.params.clientCapabilities.session.compaction).toEqual({});
      emit({ id: message.id, result: { agentCapabilities: { loadSession: true } } });
    } else if (message.method === "session/load") {
      update("thread", { status: "completed", summary: [{ type: "text", text: "replay" }] });
      emit({ id: message.id, result: { sessionId: "thread" } });
    }
  });
  const service = createOpenCodeAcpSessionService({ environmentService: { resolve: () => ({}) }, terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
  try {
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" }, { resumeThreadId: "thread" });
    update("old-thread", { status: "failed", error: "stale" });
    const snapshot = service.snapshot("one");
    expect(snapshot.items).toHaveLength(1);
    expect(toMobileGraphicalSnapshot(snapshot).items[0]).toMatchObject({ status: "completed", compactionId: "c", compactionSummary: [{ type: "text", text: "replay" }] });
    update("thread", { compactionId: "active", status: "in_progress" });
    child.emit("exit", 1);
    expect(service.snapshot("one").items[1].status).toBe("unknown");
  } finally { service.shutdown(); }
});

it("streams, replaces and clears summaries without moving the timeline record", () => {
  const items = [];
  patch(items, { status: "in_progress" });
  items.push({ id: "later", type: "agentMessage" });
  applyCompaction(items, { sessionUpdate: "compaction_summary_chunk", compactionId: "c", content: { type: "text", text: "partial" } });
  patch(items, { status: "completed", summary: [{ type: "text", text: "final" }] });
  patch(items, { status: "completed" });
  expect(items).toHaveLength(2);
  expect(items[0].compactionSummary).toEqual([{ type: "text", text: "final" }]);
  patch(items, { status: "completed", summary: null });
  expect(items[0].compactionSummary).toEqual([]);
  patch(items, { status: "completed", summary: [] });
  expect(items[0].compactionSummary).toEqual([]);
});

it("accepts terminal replay, errors and unknown states", () => {
  const items = [];
  patch(items, { status: "failed", error: "failure" });
  expect(items[0]).toMatchObject({ status: "failed", compactionError: "failure" });
  patch(items, { status: "cancelled", error: null });
  expect(items[0].compactionError).toBeUndefined();
  patch(items, { status: "future_status" });
  interruptCompactions(items);
  expect(items[0].status).toBe("future_status");
});

it("pairs legacy markers with rich updates and isolates child sources", () => {
  const items = [];
  applyCompaction(items, { sessionUpdate: "session_info_update", _meta: { "opencode/compaction": { messageId: "c", status: "started" } } });
  patch(items, { status: "completed", summary: [{ type: "text", text: "summary" }] });
  applyCompaction(items, { sessionUpdate: "session_info_update", _meta: { "opencode/compaction": { messageId: "c", status: "failed", error: { message: "child failed" } }, "opencode/child-session": { id: "child", title: "Explore" } } });
  expect(items).toHaveLength(2);
  expect(items[1]).toMatchObject({ compactionSource: "Explore", compactionError: "child failed" });
  patch(items, { status: "in_progress" });
  interruptCompactions(items);
  expect(items[0].status).toBe("unknown");
});

it("ignores malformed updates and chunks outside the active lifecycle", () => {
  const items = [];
  applyCompaction(items, { sessionUpdate: "compaction_summary_chunk", compactionId: "c", content: { type: "text", text: "orphan" } });
  patch(items, { status: "completed" });
  applyCompaction(items, { sessionUpdate: "compaction_summary_chunk", compactionId: "c", content: { type: "text", text: "late" } });
  expect(items[0].compactionSummary).toBeUndefined();
  expect(applyCompaction(items, { sessionUpdate: "agent_message_chunk" })).toBe(false);
});
