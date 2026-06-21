const net = require("node:net");
const { Client } = require("ssh2");
const { createSshSessionRuntime } = require("./ssh-session-runtime.cjs");

function createSshHookTunnelService({
  terminalManager,
  sessionStore,
  knownHostStore,
  sshSessionRuntime,
  getLocalHookPort,
  clientFactory = () => new Client(),
  netConnect = net.connect
}) {
  const tunnels = new Map();
  const sshRuntime = sshSessionRuntime || createSshSessionRuntime({
    terminalManager,
    sessionStore,
    knownHostStore,
    clientFactory
  });

  function getSession(sessionId) {
    const session = terminalManager.getSession(sessionId);
    if (!session) throw new Error("Session is not running.");
    if (session.type !== "ssh") throw new Error("SSH hook tunnels are only available for SSH sessions.");
    return session;
  }

  function getHookPort() {
    const port = Number(getLocalHookPort());
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error("Local hook server is not ready.");
    }
    return port;
  }

  function connectClient(sessionId, client, localHookPort) {
    return new Promise((resolve, reject) => {
      let settled = false;

      function fail(err) {
        tunnels.delete(sessionId);
        if (!settled) {
          settled = true;
          reject(err);
        }
      }

      client.on("tcp connection", (_info, accept, rejectConnection) => {
        const remoteStream = accept();
        const localStream = netConnect(localHookPort, "127.0.0.1");
        localStream.on("error", () => {
          remoteStream.destroy();
        });
        remoteStream.on("error", () => {
          localStream.destroy();
        });
        remoteStream.pipe(localStream).pipe(remoteStream);
      });

      sshRuntime.connectClient(sessionId, {
        client,
        actionName: "SSH hook tunnel connection"
      }).then(() => {
        client.forwardIn("127.0.0.1", 0, (err, remotePort) => {
          if (err) {
            fail(err);
            return;
          }
          settled = true;
          resolve({
            client,
            remoteHost: "127.0.0.1",
            remotePort,
            hookUrl: `http://127.0.0.1:${remotePort}/claude-hook`
          });
        });
      }).catch(fail);
      client.on("close", () => {
        tunnels.delete(sessionId);
        if (!settled) fail(new Error("SSH hook tunnel connection closed."));
      });
    });
  }

  async function ensureTunnel(sessionId) {
    getSession(sessionId);
    const cached = tunnels.get(sessionId);
    if (cached) {
      return cached.promise;
    }

    const client = clientFactory();
    const localHookPort = getHookPort();
    const entry = {
      client,
      promise: connectClient(sessionId, client, localHookPort)
    };
    tunnels.set(sessionId, entry);
    return entry.promise;
  }

  async function disconnect(sessionId) {
    const entry = tunnels.get(sessionId);
    tunnels.delete(sessionId);
    if (!entry) return;

    try {
      const tunnel = await entry.promise;
      await new Promise((resolve) => {
        tunnel.client.unforwardIn(tunnel.remoteHost, tunnel.remotePort, () => resolve());
      });
    } catch {
      // Ignore cleanup failures; the SSH connection is closed below.
    }

    try {
      entry.client.end();
    } catch {
      // Ignore close failures during session cleanup.
    }
  }

  async function shutdown() {
    await Promise.all(Array.from(tunnels.keys()).map((id) => disconnect(id)));
  }

  return {
    ensureTunnel,
    disconnect,
    shutdown
  };
}

module.exports = {
  createSshHookTunnelService
};
