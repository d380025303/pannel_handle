import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { runCodeBuddyUserInfoRequest } = require("./codebuddy-user-info-client.cjs");

function createAcpTransport(options = {}) {
  const events = new EventEmitter();
  const transport = {
    writes: [],
    close: vi.fn(),
    on: (eventName, listener) => events.on(eventName, listener),
    write: vi.fn(line => {
      const message = JSON.parse(line);
      transport.writes.push(message);
      if (message.method === "initialize") {
        queueMicrotask(() => events.emit("stdout", `${JSON.stringify({ id: message.id, result: {} })}\n`));
      } else if (message.method === "_codebuddy.ai/getUserInfo") {
        queueMicrotask(() => events.emit("stdout", `${JSON.stringify({
          id: message.id,
          result: options.loggedOut ? { userInfo: {} } : {
            userInfo: { userId: "user-1", token: "secret-token" }
          }
        })}\n`));
      }
    })
  };
  return transport;
}

describe("codebuddy-user-info-client", () => {
  it("reads nested login information through ACP without returning profile fields", async () => {
    const transport = createAcpTransport();
    await expect(runCodeBuddyUserInfoRequest(transport, { timeoutMs: 1000, maxOutputBytes: 1024 }))
      .resolves.toEqual({ userId: "user-1", token: "secret-token" });
    expect(transport.writes.map(message => message.method)).toEqual([
      "initialize",
      "_codebuddy.ai/getUserInfo"
    ]);
    expect(transport.close).toHaveBeenCalledTimes(1);

    await expect(runCodeBuddyUserInfoRequest(createAcpTransport({ loggedOut: true }), {
      timeoutMs: 1000,
      maxOutputBytes: 1024
    })).rejects.toThrow("sign in");
  });

  it("reports an ACP exit code and redacts its diagnostic", async () => {
    const events = new EventEmitter();
    const transport = {
      close: vi.fn(),
      on: (eventName, listener) => events.on(eventName, listener),
      write: vi.fn()
    };
    const request = runCodeBuddyUserInfoRequest(transport, { timeoutMs: 1000, maxOutputBytes: 1024 });
    events.emit("stderr", "Token=private-value\nLogin failed");
    events.emit("close", 1);
    await expect(request).rejects.toThrow(/code 1.*Token=\[已隐藏\].*Login failed/s);
  });
});
