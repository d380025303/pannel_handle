import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createSshHookTunnelService } = require("./ssh-hook-tunnel-service.cjs");

function createClient() {
  const client = new EventEmitter();
  client.connect = vi.fn(() => queueMicrotask(() => client.emit("ready")));
  client.forwardIn = vi.fn((_host, _port, callback) => callback(undefined, 31847));
  client.unforwardIn = vi.fn((_host, _port, callback) => callback());
  client.end = vi.fn();
  return client;
}

describe("ssh-hook-tunnel-service", () => {
  it("opens a reverse tunnel and reuses it for a session", async () => {
    const client = createClient();
    const service = createSshHookTunnelService({
      terminalManager: {
        getSession: () => ({
          id: "run-1",
          type: "ssh",
          sshConfig: { host: "example.com", username: "deploy" }
        })
      },
      sessionStore: {},
      getLocalHookPort: () => 4567,
      clientFactory: () => client
    });

    await expect(service.ensureTunnel("run-1")).resolves.toMatchObject({
      remoteHost: "127.0.0.1",
      remotePort: 31847,
      hookUrl: "http://127.0.0.1:31847/claude-hook"
    });
    await service.ensureTunnel("run-1");

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.forwardIn).toHaveBeenCalledWith("127.0.0.1", 0, expect.any(Function));
  });

  it("unforwards and closes the tunnel on disconnect", async () => {
    const client = createClient();
    const service = createSshHookTunnelService({
      terminalManager: {
        getSession: () => ({
          id: "run-1",
          type: "ssh",
          sshConfig: { host: "example.com" }
        })
      },
      sessionStore: {},
      getLocalHookPort: () => 4567,
      clientFactory: () => client
    });

    await service.ensureTunnel("run-1");
    await service.disconnect("run-1");

    expect(client.unforwardIn).toHaveBeenCalledWith("127.0.0.1", 31847, expect.any(Function));
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("rejects when the local hook server is not ready", async () => {
    const service = createSshHookTunnelService({
      terminalManager: {
        getSession: () => ({
          id: "run-1",
          type: "ssh",
          sshConfig: { host: "example.com" }
        })
      },
      sessionStore: {},
      getLocalHookPort: () => undefined
    });

    await expect(service.ensureTunnel("run-1")).rejects.toThrow("Local hook server is not ready.");
  });
});
