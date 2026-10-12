// Streaming IPC must not wait for snapshot construction or history scans.
function createGraphicalArchiveScheduler({ broadcast, snapshot, archive, intervalMs = 1000 }) {
  const pending = new Map();
  let stopped = false;
  function flush(id, value) {
    const timer = pending.get(id);
    if (timer) clearTimeout(timer);
    pending.delete(id);
    try { archive(id, value === undefined ? snapshot(id) : value); } catch {}
  }
  function flushAll() {
    for (const id of [...pending.keys()]) flush(id);
  }
  return {
    broadcast(channel, payload) {
      broadcast(channel, payload);
      if (stopped) return;
      if (channel === "codex-app-server:changed") flush(payload.id, payload.snapshot);
      if (channel === "codex-app-server:delta" && !pending.has(payload.id)) {
        const timer = setTimeout(() => flush(payload.id), intervalMs);
        timer.unref?.();
        pending.set(payload.id, timer);
      }
    },
    flush,
    flushAll,
    shutdown() { stopped = true; flushAll(); }
  };
}
module.exports = { createGraphicalArchiveScheduler };
