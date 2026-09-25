import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createCodeBuddyAcpSessionService } = require("./session-service.cjs");

function fakeChild(onMessage) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn();
  child.stdin.on("data", chunk => onMessage(JSON.parse(String(chunk)), value => child.stdout.write(`${JSON.stringify(value)}\n`)));
  return child;
}

function serviceWithChild(child, onTokenUsageCheckpoint) {
  return createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
    terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child,
    resolveHttpEndpoint: async () => ({ endpoint: new URL("http://127.0.0.1:12345"), password: "test" }),
    httpTransportFactory: () => {
      const events = new EventEmitter();
      readline.createInterface({ input: child.stdout }).on("line", line => events.emit("message", JSON.parse(line)));
      return { on: (name, listener) => events.on(name, listener), connect: async () => {},
        send: async message => { child.stdin.write(`${JSON.stringify(message)}\n`); }, close: () => {} };
    }, onTokenUsageCheckpoint });
}

describe("CodeBuddy graphical token checkpoints", () => {
  it("records completed turns and baselines resumed sessions without using context occupancy", async () => {
    let emitUpdate;
    const checkpoint = vi.fn(async () => {});
    const child = fakeChild((message, emit) => {
      emitUpdate = emit;
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id,
        result: { agentCapabilities: { loadSession: true } } });
      else if (message.method === "session/new" || message.method === "session/load")
        emit({ jsonrpc: "2.0", id: message.id,
          result: { sessionId: message.method === "session/load" ? "old" : "fresh" } });
      else if (message.method === "session/prompt") emit({ jsonrpc: "2.0", id: message.id,
        result: { stopReason: "end_turn" } });
    });
    const session = { id: "panel", type: "windows", cwd: "C:\\work" };
    const service = serviceWithChild(child, checkpoint);
    await service.start(session);
    await service.submit("panel", "hello");
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ threadId: "fresh", session }));
    emitUpdate({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fresh",
      update: { sessionUpdate: "usage_update", used: 100, size: 200000 } } });
    expect(checkpoint).toHaveBeenCalledTimes(1);
    service.shutdown();

    const resumed = serviceWithChild(fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id,
        result: { agentCapabilities: { loadSession: true } } });
      else if (message.method === "session/load") emit({ jsonrpc: "2.0", id: message.id,
        result: { sessionId: "old" } });
    }), checkpoint);
    await resumed.start(session, { resumeThreadId: "old" });
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ threadId: "old", resumed: true }));
    resumed.shutdown();
  });
});
