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
    hub.shutdown();
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
