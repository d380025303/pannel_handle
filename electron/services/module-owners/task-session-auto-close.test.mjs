import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const { createTaskSessionAutoClose } = createRequire(import.meta.url)("./task-session-auto-close.cjs");
function fixture() {
  let listener;
  const snapshot = { threadId: "thread", completedTurnId: "turn", busy: false };
  const session = { id: "session", runtimeMode: "app-server" };
  const close = vi.fn(); const notify = vi.fn(); const unsubscribe = vi.fn();
  const service = createTaskSessionAutoClose({ terminalManager: { getSession: () => session },
    graphicalService: { snapshot: () => snapshot, getInjectedToolState: () => snapshot, onTaskError: fn => { listener = fn; return unsubscribe; } },
    getAgentStatus: () => ({ status: "completed" }), closeSession: close, notify });
  const job = { autoCloseSession: true, status: "completed", sessionId: "session", threadId: "thread", turnId: "turn", output: "done" };
  service.track(job);
  return { service, job, snapshot, close, notify, unsubscribe, error: event => listener({ sessionId: "session", threadId: "thread", error: "command failed", ...event }) };
}
it("closes exactly once after output persistence and all confirmations finish", async () => {
  const f = fixture(); f.job.historyDirty = true;
  await f.service.tick(); expect(f.close).not.toHaveBeenCalled();
  f.job.historyDirty = false; f.snapshot.approvals = [{}];
  await f.service.tick(); expect(f.close).not.toHaveBeenCalled();
  f.snapshot.approvals = []; f.snapshot.elicitations = [{}];
  await f.service.tick(); expect(f.close).not.toHaveBeenCalled();
  f.snapshot.elicitations = []; await f.service.tick(); await f.service.tick();
  expect(f.close).toHaveBeenCalledExactlyOnceWith("session"); f.service.shutdown();
});
it("retains command errors after recovery and deduplicates notifications", async () => {
  const f = fixture(); f.job.status = "running"; f.error(); f.error();
  f.job.status = "completed"; await f.service.tick();
  expect(f.close).not.toHaveBeenCalled(); expect(f.notify).toHaveBeenCalledTimes(1); f.service.shutdown();
});
it("retains storage errors even after retry succeeds", async () => {
  const f = fixture(); f.service.error(f.job, "storage failed"); await f.service.tick();
  expect(f.close).not.toHaveBeenCalled(); expect(f.notify).toHaveBeenCalledTimes(1); f.service.shutdown();
});
it("does not close a later turn, even if it subsequently returns to the old identity", async () => {
  const f = fixture(); f.snapshot.turnId = "later"; await f.service.tick();
  delete f.snapshot.turnId; await f.service.tick(); expect(f.close).not.toHaveBeenCalled(); f.service.shutdown();
});
it("retains after close failure without retry and unsubscribes on shutdown", async () => {
  const f = fixture(); f.close.mockRejectedValue(new Error("close failed"));
  await f.service.tick(); await f.service.tick(); expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.notify).toHaveBeenCalledTimes(1); f.service.shutdown(); expect(f.unsubscribe).toHaveBeenCalledTimes(1);
});
it("tracks distinct runs concurrently and ignores disabled instances", async () => {
  const f = fixture(); f.service.track({ ...f.job, autoCloseSession: false });
  f.service.track({ ...f.job }); await f.service.tick(); expect(f.close).toHaveBeenCalledTimes(2); f.service.shutdown();
});
