import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import socketModule from "./mobile-socket-handlers.cjs";
import protocolModule from "./mobile-protocol.cjs";
import hubModule from "../../terminal/terminal-state-hub.cjs";

const hubs = [];
afterEach(() => { for (const hub of hubs.splice(0)) hub.shutdown(); });

function fixture() {
  const stateHub = hubModule.createTerminalStateHub();
  hubs.push(stateHub);
  stateHub.start("one");
  stateHub.start("two");
  const messages = [];
  const sendError = vi.fn();
  const handlers = socketModule.createMobileSocketHandlers({
    terminalManager: { getSession: id => ({ id, runtimeMode: "terminal" }) },
    stateHub, now: () => 1, auth: { handleSocketClosed: vi.fn() },
    sizes: { getSizeState: () => ({ owner: "desktop", cols: 100, rows: 30 }) },
    send: (_socket, message) => messages.push(message), sendError
  });
  const socket = Object.assign(new EventEmitter(), { mobileDevice: { id: "phone" } });
  handlers.handleWebSocket(socket, { socket: { remoteAddress: "192.168.1.2" } });
  socket.authenticated = true;
  const subscribe = (sessionId = "one", lastSeq) => socket.emit("message", JSON.stringify({
    v: protocolModule.PROTOCOL_VERSION, type: "terminal.subscribe", sessionId, lastSeq
  }));
  const write = (data, sessionId = "one") => {
    const seq = stateHub.write(sessionId, data);
    handlers.handleTerminalData(socket, { type: "terminal.data", sessionId, data, seq });
  };
  return { stateHub, messages, socket, subscribe, write, sendError };
}

describe("mobile terminal subscription ordering", () => {
  it("sends the initial snapshot before concurrent output and displays each chunk once", async () => {
    const f = fixture();
    f.write("BEFORE\r\n");
    f.subscribe();
    f.write("AFTER\r\n");
    expect(f.messages).toEqual([]);
    await vi.waitFor(() => expect(f.messages).toHaveLength(2));
    expect(f.messages[0]).toMatchObject({ type: "terminal.snapshot", snapshot: { seq: 1 } });
    expect(f.messages[1]).toEqual({ type: "terminal.data", sessionId: "one", data: "AFTER\r\n", seq: 2 });

    // Apply the same reset/write/sequence rules as the mobile terminal to a real terminal.
    const display = hubModule.createTerminalStateHub();
    hubs.push(display);
    let lastSeq = 0;
    for (const message of f.messages) {
      if (message.type === "terminal.snapshot") {
        display.start("display", message.snapshot.cols, message.snapshot.rows);
        display.write("display", message.snapshot.ansi);
        lastSeq = message.snapshot.seq;
      } else if (message.seq > lastSeq) {
        display.write("display", message.data);
        lastSeq = message.seq;
      }
    }
    const text = await display.getText("display");
    expect(text.match(/BEFORE/g)).toHaveLength(1);
    expect(text.match(/AFTER/g)).toHaveLength(1);
    expect(lastSeq).toBe(2);
    f.write("LIVE");
    expect(f.messages.at(-1)).toMatchObject({ type: "terminal.data", data: "LIVE", seq: 3 });
    expect(f.sendError).not.toHaveBeenCalled();
  });

  it("omits buffered output already included in the snapshot", async () => {
    const f = fixture();
    const getSnapshot = f.stateHub.getSnapshot;
    let resolve;
    f.stateHub.getSnapshot = () => new Promise(done => { resolve = done; });
    f.subscribe();
    f.write("INCLUDED");
    resolve(await getSnapshot("one"));
    await vi.waitFor(() => expect(f.messages).toHaveLength(1));
    expect(f.messages[0]).toMatchObject({ type: "terminal.snapshot", snapshot: { seq: 1, ansi: "INCLUDED" } });
  });

  it.each(["switch", "close", "resubscribe"])("discards a pending snapshot after %s", async action => {
    const f = fixture();
    let resolve;
    const snapshot = await f.stateHub.getSnapshot("one");
    f.stateHub.getSnapshot = () => new Promise(done => { resolve = done; });
    f.subscribe();
    const finishOld = resolve;
    f.write("OLD");
    if (action === "close") f.socket.emit("close", 1000);
    else f.subscribe(action === "switch" ? "two" : "one", 0);
    const before = [...f.messages];
    finishOld(snapshot);
    await new Promise(done => setImmediate(done));
    expect(f.messages).toEqual(before);
    expect(f.messages.some(message => message.type === "terminal.snapshot")).toBe(false);
  });

  it("replays reconnect deltas and then forwards live output", () => {
    const f = fixture();
    f.write("BEFORE");
    f.write("AFTER");
    f.subscribe("one", 1);
    f.write("LIVE");
    expect(f.messages.map(message => message.type)).toEqual(["terminal.data", "terminal.size-owner", "terminal.data"]);
    expect(f.messages.filter(message => message.type === "terminal.data").map(message => message.seq)).toEqual([2, 3]);
  });
});
