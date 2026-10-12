import { describe, expect, it } from "vitest";
import { createTerminalStateHub } from "./terminal-state-hub.cjs";

describe("terminal state hub", () => {
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
