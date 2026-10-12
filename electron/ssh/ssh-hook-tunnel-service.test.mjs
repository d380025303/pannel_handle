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
  it("closes every rejected forwarding connection and preserves a successful retry after old close events", async () => {
    const clients = Array.from({ length: 4 }, () => createClient());
    const forwardingError = new Error("Remote port forwarding denied.");
    for (const client of clients.slice(0, 3)) {
      client.forwardIn.mockImplementation((_host, _port, callback) => callback(forwardingError));
    }
    // Exercise reentrant close events and best-effort cleanup.
    clients[0].end.mockImplementation(() => clients[0].emit("close"));
    clients[1].end.mockImplementation(() => { throw new Error("Close failed."); });
    const clientFactory = vi.fn();
    for (const client of clients) clientFactory.mockReturnValueOnce(client);
    const service = createSshHookTunnelService({
      terminalManager: { getSession: () => ({ type: "ssh" }) },
      sshSessionRuntime: { connectClient: vi.fn(() => Promise.resolve()) },
      getLocalHookPort: () => 4567,
      clientFactory
    });

    for (const client of clients.slice(0, 3)) {
      await expect(service.ensureTunnel("run-1")).rejects.toBe(forwardingError);
      expect(client.end).toHaveBeenCalledTimes(1);
    }
    await service.disconnect("run-1");
    await service.shutdown();
    for (const client of clients.slice(0, 3)) expect(client.end).toHaveBeenCalledTimes(1);

    const tunnel = await service.ensureTunnel("run-1");
    for (const client of clients.slice(0, 3)) client.emit("close");
    await expect(service.ensureTunnel("run-1")).resolves.toBe(tunnel);
    expect(clientFactory).toHaveBeenCalledTimes(4);
    expect(clients[3].forwardIn).toHaveBeenCalledTimes(1);
    expect(clients[3].end).not.toHaveBeenCalled();

    await service.shutdown();
    expect(clients[3].unforwardIn).toHaveBeenCalledTimes(1);
    expect(clients[3].end).toHaveBeenCalledTimes(1);
  });

  it("preserves a replacement tunnel when the disconnected client closes later", async () => {
    const oldClient = createClient();
    const newClient = createClient();
    const clientFactory = vi.fn().mockReturnValueOnce(oldClient).mockReturnValueOnce(newClient);
    const service = createSshHookTunnelService({
      terminalManager: { getSession: () => ({ type: "ssh" }) },
      sshSessionRuntime: { connectClient: vi.fn(() => Promise.resolve()) },
      getLocalHookPort: () => 4567,
      clientFactory
    });

    await service.ensureTunnel("run-1");
    await service.disconnect("run-1");
    const tunnel = await service.ensureTunnel("run-1");
    oldClient.emit("close");
    await expect(service.ensureTunnel("run-1")).resolves.toBe(tunnel);
    expect(clientFactory).toHaveBeenCalledTimes(2);
    await service.disconnect("run-1");
    expect(newClient.end).toHaveBeenCalledTimes(1);
  });

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
