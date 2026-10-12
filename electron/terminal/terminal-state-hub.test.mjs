import { describe, expect, it } from "vitest";
import { createTerminalStateHub } from "./terminal-state-hub.cjs";

describe("terminal state hub", () => {
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
});
