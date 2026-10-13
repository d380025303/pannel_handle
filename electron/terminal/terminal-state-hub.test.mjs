import { describe, expect, it, vi } from "vitest";
import { createTerminalStateHub, MAX_DELTA_COUNT, MAX_WRITE_BATCH_CHARS } from "./terminal-state-hub.cjs";

describe("terminal state hub", () => {
  it("bounds single-byte deltas through repeated compaction without losing snapshot output", async () => {
    const hub = createTerminalStateHub();
    try {
      const state = hub.start("run-1");
      const count = MAX_DELTA_COUNT * 3 + 1;
      for (let seq = 1; seq <= count; seq += 1) {
        hub.write("run-1", "x");
        expect(state.deltas.length - state.deltaHead).toBe(Math.min(seq, MAX_DELTA_COUNT));
      }
      const first = count - MAX_DELTA_COUNT + 1;
      expect(state.deltaBytes).toBe(MAX_DELTA_COUNT);
      expect(state.deltas.length).toBeLessThan(MAX_DELTA_COUNT * 2);
      expect(state.deltas.slice(0, state.deltaHead).every((event) => event === null)).toBe(true);
      expect(hub.getDeltas("run-1", first - 2)).toBeNull();
      expect(hub.getDeltas("run-1", first - 1)).toEqual(
        Array.from({ length: MAX_DELTA_COUNT }, (_, index) => ({ seq: first + index, data: "x" }))
      );
      expect(hub.getDeltas("run-1", count - 1)).toEqual([{ seq: count, data: "x" }]);
      expect(hub.getDeltas("run-1", count)).toEqual([]);
      const snapshot = await hub.getSnapshot("run-1");
      expect(snapshot.seq).toBe(count);
      expect(snapshot.ansi.match(/x/g)).toHaveLength(count);
    } finally {
      hub.shutdown();
    }
  });

  it("preserves delta boundaries through repeated eviction and compaction", async () => {
    const hub = createTerminalStateHub({ maxDeltaBytes: 24 });
    try {
      const state = hub.start("run-1", 40, 3);
      const data = "日志\r\n";
      const count = 3100;
      for (let seq = 1; seq <= count; seq += 1) {
        expect(hub.write("run-1", data)).toBe(seq);
        const first = Math.max(1, seq - 2);
        expect(hub.getDeltas("run-1", first - 1)).toEqual(
          Array.from({ length: seq - first + 1 }, (_, index) => ({ seq: first + index, data }))
        );
        if (first > 1) expect(hub.getDeltas("run-1", first - 2)).toBeNull();
        expect(hub.getDeltas("run-1", seq)).toEqual([]);
        expect(state.deltaBytes).toBe(Math.min(seq, 3) * Buffer.byteLength(data, "utf8"));
      }
      expect(state.deltas.length).toBeLessThan(1027);
      expect(state.deltas.slice(0, state.deltaHead).every((event) => event === null)).toBe(true);
      expect(hub.getDeltas("run-1", count - 1)).toEqual([{ seq: count, data }]);
      expect(await hub.getSnapshot("run-1")).toMatchObject({ seq: count });
      expect(await hub.getText("run-1", 200)).toContain("日志");
      hub.start("run-1");
      expect(hub.getSequence("run-1")).toBe(0);
      expect(hub.getDeltas("run-1", 0)).toEqual([]);
    } finally {
      hub.shutdown();
    }
  });

  it("keeps the newest oversized delta and evicts it on subsequent output", async () => {
    const hub = createTerminalStateHub({ maxDeltaBytes: 4 });
    try {
      hub.write("run-1", "hello");
      expect(hub.getDeltas("run-1", 0)).toEqual([{ seq: 1, data: "hello" }]);
      expect(hub.ensure("run-1").deltaBytes).toBe(5);
      hub.write("run-1", "界");
      expect(hub.getDeltas("run-1", 0)).toBeNull();
      expect(hub.getDeltas("run-1", 1)).toEqual([{ seq: 2, data: "界" }]);
      expect(hub.ensure("run-1").deltaBytes).toBe(3);
      expect(await hub.getSnapshot("run-1")).toMatchObject({ ansi: "hello界", seq: 2 });
    } finally {
      hub.shutdown();
    }
  });

  it.each([1000, 3000])("batches %i small writes while preserving every delta", async (count) => {
    const hub = createTerminalStateHub();
    try {
      const state = hub.start("run-1");
      const write = vi.spyOn(state.terminal, "write");
      const data = "log entry 1234567890\r\n";
      for (let index = 0; index < count; index += 1) hub.write("run-1", data);
      const snapshot = await hub.getSnapshot("run-1");
      expect(snapshot.seq).toBe(count);
      expect(snapshot.ansi.match(/log entry 1234567890/g)).toHaveLength(count);
      expect(hub.getDeltas("run-1", 0)).toEqual(
        Array.from({ length: count }, (_, index) => ({ seq: index + 1, data }))
      );
      expect(write).toHaveBeenCalledTimes(Math.ceil(data.length * count / MAX_WRITE_BATCH_CHARS));
      expect(write.mock.calls.every(([text]) => text.length <= MAX_WRITE_BATCH_CHARS)).toBe(true);
    } finally {
      hub.shutdown();
    }
  });

  it("bounds large writes without splitting surrogate pairs", async () => {
    const hub = createTerminalStateHub();
    try {
      const state = hub.start("run-1");
      const write = vi.spyOn(state.terminal, "write");
      const data = "x".repeat(MAX_WRITE_BATCH_CHARS - 1) + "😀END";
      hub.write("run-1", data);
      const snapshot = await hub.getSnapshot("run-1");
      expect(snapshot.ansi).toContain("😀END");
      expect(write.mock.calls.map(([text]) => text).join("")).toBe(data);
      expect(write.mock.calls.every(([text]) => text.length <= MAX_WRITE_BATCH_CHARS)).toBe(true);
      expect(snapshot.seq).toBe(1);
    } finally {
      hub.shutdown();
    }
  });

  it("seals snapshot dimensions before subsequent output and resize", async () => {
    const hub = createTerminalStateHub();
    try {
      hub.start("run-1", 40, 8);
      hub.write("run-1", "FIRST");
      const first = hub.getSnapshot("run-1");
      hub.resize("run-1", 20, 5);
      hub.write("run-1", "SECOND");
      expect(await first).toMatchObject({ ansi: "FIRST", seq: 1, cols: 40, rows: 8 });
      expect(await hub.getSnapshot("run-1")).toMatchObject({ ansi: "FIRSTSECOND", seq: 2, cols: 20, rows: 5 });
    } finally {
      hub.shutdown();
    }
  });

  it("preserves configured scrollback in the initial snapshot", async () => {
    const hub = createTerminalStateHub({ scrollback: 20 });
    const restored = createTerminalStateHub({ scrollback: 20 });
    try {
      hub.start("run-1", 40, 3);
      for (let line = 1; line <= 12; line += 1) {
        hub.write("run-1", `LINE_${line}\r\n`);
      }

      const snapshot = await hub.getSnapshot("run-1", "phone");
      const expectedLines = Array.from({ length: 12 }, (_, index) => `LINE_${index + 1}`);
      expect(snapshot.ansi.match(/LINE_\d+/g)).toEqual(expectedLines);

      const state = restored.start("run-1", snapshot.cols, snapshot.rows);
      restored.write("run-1", snapshot.ansi);
      await restored.getSnapshot("run-1");
      const buffer = state.terminal.buffer.active;
      expect(buffer.baseY).toBeGreaterThan(0);
      expect(Array.from({ length: buffer.length }, (_, index) =>
        buffer.getLine(index).translateToString(true)
      ).filter(Boolean)).toEqual(expectedLines);
    } finally {
      hub.shutdown();
      restored.shutdown();
    }
  });

  it("serializes the current screen and sequences output", async () => {
    const hub = createTerminalStateHub({ scrollback: 20 });
    hub.start("run-1", 40, 8);
    expect(hub.write("run-1", "hello\r\n")).toBe(1);
    expect(hub.write("run-1", "world")).toBe(2);
    const snapshot = await hub.getSnapshot("run-1", "desktop");
    expect(snapshot.ansi).toContain("hello");
    expect(snapshot.ansi).toContain("world");
    expect(snapshot.seq).toBe(2);
    expect(hub.getDeltas("run-1", 1)).toEqual([{ seq: 2, data: "world" }]);
    expect(await hub.getText("run-1", 2)).toContain("world");
    hub.shutdown();
  });

  it("keeps output queued during a snapshot available as deltas", async () => {
    const hub = createTerminalStateHub();
    try {
      hub.write("run-1", "FIRST");
      const pendingSnapshot = hub.getSnapshot("run-1");
      hub.write("run-1", "SECOND");

      const snapshot = await pendingSnapshot;
      expect(snapshot.ansi).toBe("FIRST");
      expect(snapshot.seq).toBe(1);
      const deltas = hub.getDeltas("run-1", snapshot.seq);
      expect(deltas).toEqual([{ seq: 2, data: "SECOND" }]);
      expect(snapshot.ansi + deltas.map((event) => event.data).join("")).toBe("FIRSTSECOND");
      expect(await hub.getText("run-1")).toBe("FIRSTSECOND");

      const latestSnapshot = await hub.getSnapshot("run-1");
      expect(latestSnapshot.ansi).toBe("FIRSTSECOND");
      expect(latestSnapshot.seq).toBe(2);
      expect(hub.getDeltas("run-1", latestSnapshot.seq)).toEqual([]);
    } finally {
      hub.shutdown();
    }
  });

  it("resizes one shared screen model", async () => {
    const hub = createTerminalStateHub();
    hub.start("run-1", 100, 30);
    hub.resize("run-1", 50, 20);
    const snapshot = await hub.getSnapshot("run-1", "phone");
    expect({ cols: snapshot.cols, rows: snapshot.rows }).toEqual({ cols: 50, rows: 20 });
    hub.shutdown();
  });

  it.each([
    ["output followed by resize", [
      ["write", "\x1b[1;30HX"],
      ["resize", 40, 5]
    ]],
    ["interleaved output and resizes", [
      ["write", "\x1b[1;30HX"],
      ["resize", 40, 5],
      ["write", "\x1b[2;35HY"],
      ["resize", 20, 5],
      ["write", "\x1b[3;30HZ"],
      ["resize", 40, 5],
      ["resize", 20, 5],
      ["resize", 40, 5]
    ]]
  ])("preserves call order for %s", async (_name, operations) => {
    const queued = createTerminalStateHub();
    const sequential = createTerminalStateHub();
    try {
      queued.start("run-1", 20, 5);
      sequential.start("run-1", 20, 5);
      for (const [method, ...args] of operations) queued[method]("run-1", ...args);
      for (const [method, ...args] of operations) {
        sequential[method]("run-1", ...args);
        await sequential.getSnapshot("run-1");
      }

      expect(await queued.getSnapshot("run-1")).toEqual(await sequential.getSnapshot("run-1"));
      expect((await queued.getText("run-1")).split("\n")[0]).toBe("X");
      expect(queued.ensure("run-1").terminal.buffer.active.getLine(0).translateToString(true))
        .toBe(" ".repeat(19) + "X");
    } finally {
      queued.shutdown();
      sequential.shutdown();
    }
  });
});
