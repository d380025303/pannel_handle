import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createGraphicalArchiveScheduler } = require("./graphical-archive-scheduler.cjs");
const { createConversationArchiveService } = require("./conversation-archive-service.cjs");
afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  const saved = new Map();
  const store = {
    start: session => session.id, associate() {}, captureStatus() {}, finish() {}, close() {},
    save: (id, thread, messages) => {
      for (const message of messages) saved.set(`${id}:${message.id}`, message);
    }
  };
  const archive = createConversationArchiveService({ store, now: () => 1 });
  const snapshots = new Map();
  const snapshot = vi.fn(id => structuredClone(snapshots.get(id)));
  const scan = vi.fn((id, value) => archive.graphical(id, value));
  const broadcast = vi.fn(() => {
    // No snapshot or history scan may precede delivery of a streaming event.
    expect(snapshot).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });
  const scheduler = createGraphicalArchiveScheduler({ broadcast, snapshot, archive: scan });
  function start(id, count = 1) {
    archive.start({ id, agentProvider: "codex", runtimeMode: "app-server" });
    archive.baseline(id, { threadId: id, items: [] });
    const value = { threadId: id, items: Array.from({ length: count }, (_, i) => ({
      id: String(i), type: "agentMessage", text: "x".repeat(4096)
    })) };
    snapshots.set(id, value);
    return value;
  }
  return { archive, saved, snapshots, snapshot, scan, broadcast, scheduler, start };
}

it.each([100, 2000])("coalesces 100 character updates with %i historical messages and saves final text", count => {
  const f = fixture();
  const value = f.start("a", count);
  for (let i = 0; i < 100; i++) {
    value.items[count - 1].text += "z";
    f.scheduler.broadcast("codex-app-server:delta", { id: "a" });
    vi.advanceTimersByTime(9);
  }
  expect(f.broadcast).toHaveBeenCalledTimes(100);
  expect(f.scan).not.toHaveBeenCalled();
  vi.advanceTimersByTime(100);
  expect(f.snapshot).toHaveBeenCalledTimes(1);
  expect(f.scan).toHaveBeenCalledTimes(1);
  expect(f.saved.get(`a:${count - 1}`).text).toBe("x".repeat(4096) + "z".repeat(100));
  f.scheduler.shutdown();
  f.archive.shutdown();
  expect(vi.getTimerCount()).toBe(0);
});

it("flushes full completion snapshots immediately and cancels the pending scan", () => {
  const f = fixture();
  const value = f.start("a");
  f.scheduler.broadcast("codex-app-server:delta", { id: "a" });
  value.items[0].text = "complete";
  f.scheduler.broadcast("codex-app-server:changed", { id: "a", snapshot: value });
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(f.saved.get("a:0").text).toBe("complete");
  vi.advanceTimersByTime(2000);
  expect(f.scan).toHaveBeenCalledTimes(1);
  f.scheduler.shutdown(); f.archive.shutdown();
});

it("isolates sessions and flushes before session finish and application shutdown", () => {
  const f = fixture();
  f.start("a").items[0].text = "session a";
  f.start("b").items[0].text = "session b";
  for (const id of ["a", "b"]) f.scheduler.broadcast("codex-app-server:delta", { id });
  f.scheduler.flush("a");
  f.archive.finish("a");
  expect(f.saved.get("a:0").text).toBe("session a");
  expect(f.saved.has("b:0")).toBe(false);
  f.scheduler.shutdown();
  expect(f.saved.get("b:0").text).toBe("session b");
  f.broadcast.mockImplementation(() => {});
  f.scheduler.broadcast("codex-app-server:delta", { id: "b" });
  vi.advanceTimersByTime(2000);
  expect(f.scan).toHaveBeenCalledTimes(2);
  f.archive.shutdown();
  expect(vi.getTimerCount()).toBe(0);
});

it("continues periodic capture during uninterrupted streaming", () => {
  const f = fixture();
  const value = f.start("a");
  f.broadcast.mockImplementation(() => {});
  for (let i = 0; i < 30; i++) {
    value.items[0].text += "z";
    f.scheduler.broadcast("codex-app-server:delta", { id: "a" });
    vi.advanceTimersByTime(100);
  }
  expect(f.scan).toHaveBeenCalledTimes(3);
  expect(f.saved.get("a:0").text).toBe(value.items[0].text);
  f.scheduler.shutdown(); f.archive.shutdown();
});

it("flushes all pending snapshots before waiting for archive persistence on exit", async () => {
  const f = fixture();
  for (const id of ["a", "b"]) {
    f.start(id).items[0].text = `final ${id}`;
    f.scheduler.broadcast("codex-app-server:delta", { id });
  }
  f.scheduler.flushAll();
  await f.archive.flush();
  expect(f.saved.get("a:0").text).toBe("final a");
  expect(f.saved.get("b:0").text).toBe("final b");
  vi.advanceTimersByTime(2000);
  expect(f.scan).toHaveBeenCalledTimes(2);
  f.scheduler.shutdown(); f.archive.shutdown();
  expect(vi.getTimerCount()).toBe(0);
});

it("clears pending work even when a session snapshot is no longer available", () => {
  const f = fixture();
  f.snapshot.mockImplementation(() => { throw new Error("closed"); });
  f.scheduler.broadcast("codex-app-server:delta", { id: "closed" });
  expect(() => f.scheduler.shutdown()).not.toThrow();
  expect(f.scan).not.toHaveBeenCalled();
  f.archive.shutdown();
  expect(vi.getTimerCount()).toBe(0);
});
