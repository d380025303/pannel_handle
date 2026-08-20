const fsp = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const PROTOCOL_VERSION = 1;
const DISCOVERY_STALE_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BUFFER_CHARS = 1024 * 1024;

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function bridgeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function validateDiscovery(value, now = Date.now()) {
  if (!value || typeof value !== "object") throw bridgeError("INVALID_DISCOVERY", "IDEA bridge discovery is invalid.");
  const bridgeId = String(value.bridgeId || "").trim();
  const token = String(value.token || "").trim();
  const port = Number(value.port);
  const pid = Number(value.pid);
  const updatedAt = Number(value.updatedAt);
  if (value.protocolVersion !== PROTOCOL_VERSION) throw bridgeError("PROTOCOL_MISMATCH", `Unsupported IDEA bridge protocol: ${value.protocolVersion}`);
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(bridgeId)) throw bridgeError("INVALID_DISCOVERY", "IDEA bridge ID is invalid.");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw bridgeError("INVALID_DISCOVERY", "IDEA bridge token is invalid.");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw bridgeError("INVALID_DISCOVERY", "IDEA bridge port is invalid.");
  if (!Number.isInteger(pid) || pid <= 0) throw bridgeError("INVALID_DISCOVERY", "IDEA bridge PID is invalid.");
  if (!Number.isFinite(updatedAt) || now - updatedAt > DISCOVERY_STALE_MS || updatedAt > now + 5000) {
    throw bridgeError("STALE_DISCOVERY", "IDEA bridge discovery is stale.");
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    bridgeId,
    token,
    port,
    pid,
    updatedAt,
    productName: String(value.productName || "IntelliJ IDEA"),
    productVersion: String(value.productVersion || ""),
    buildNumber: String(value.buildNumber || "")
  };
}

function normalizeBridgeSnapshot(value, discovery) {
  if (!value || typeof value !== "object" || value.protocolVersion !== PROTOCOL_VERSION || value.bridgeId !== discovery.bridgeId) {
    throw bridgeError("INVALID_RESPONSE", "IDEA bridge returned an invalid snapshot.");
  }
  const projects = Array.isArray(value.projects) ? value.projects : [];
  return {
    protocolVersion: PROTOCOL_VERSION,
    bridgeId: discovery.bridgeId,
    productName: String(value.productName || discovery.productName),
    productVersion: String(value.productVersion || discovery.productVersion),
    buildNumber: String(value.buildNumber || discovery.buildNumber),
    projects
  };
}

function createIdeaBridgeService({ discoveryDir, broadcast = () => {}, connect = net.createConnection, processAlive = isProcessAlive, scanIntervalMs = 2000 } = {}) {
  if (!discoveryDir) throw new Error("IDEA bridge discovery directory is required.");
  const connections = new Map();
  let scanTimer;
  let pollTimer;
  let stopped = false;

  function publicConnection(connection) {
    return {
      bridgeId: connection.discovery.bridgeId,
      pid: connection.discovery.pid,
      productName: connection.snapshot?.productName || connection.discovery.productName,
      productVersion: connection.snapshot?.productVersion || connection.discovery.productVersion,
      buildNumber: connection.snapshot?.buildNumber || connection.discovery.buildNumber,
      status: connection.status,
      projects: connection.snapshot?.projects || [],
      error: connection.error
    };
  }

  function getSnapshot() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      connections: Array.from(connections.values()).map(publicConnection).sort((a, b) => a.productName.localeCompare(b.productName) || a.pid - b.pid),
      updatedAt: Date.now()
    };
  }

  function publish() {
    broadcast("idea-bridge:changed", getSnapshot());
  }

  function settlePending(connection, error) {
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    connection.pending.clear();
  }

  function closeConnection(connection, reason, publishChange = true) {
    if (connection.socket) {
      connection.socket.removeAllListeners();
      connection.socket.destroy();
      connection.socket = undefined;
    }
    connection.buffer = "";
    connection.authenticated = false;
    settlePending(connection, bridgeError("IDEA_DISCONNECTED", reason || "IDEA bridge disconnected."));
    if (connection.status !== "error") connection.status = "disconnected";
    if (reason) connection.error = reason;
    if (publishChange) publish();
  }

  function sendLine(connection, message) {
    if (!connection.socket || connection.socket.destroyed) throw bridgeError("IDEA_DISCONNECTED", "IDEA bridge is not connected.");
    connection.socket.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  function request(connection, method, params = {}) {
    if (!connection.authenticated || connection.status !== "connected") {
      return Promise.reject(bridgeError("IDEA_DISCONNECTED", "IDEA bridge is not connected."));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(requestId);
        reject(bridgeError("IDEA_TIMEOUT", `IDEA bridge request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      connection.pending.set(requestId, { resolve, reject, timer });
      try {
        sendLine(connection, { type: "request", requestId, method, params });
      } catch (error) {
        clearTimeout(timer);
        connection.pending.delete(requestId);
        reject(error);
      }
    });
  }

  async function refreshSnapshot(connection) {
    const result = await request(connection, "snapshot");
    connection.snapshot = normalizeBridgeSnapshot(result, connection.discovery);
    connection.error = undefined;
    publish();
    return connection.snapshot;
  }

  function handleMessage(connection, message) {
    if (!connection.authenticated) {
      if (message?.type !== "auth" || message.ok !== true || message.protocolVersion !== PROTOCOL_VERSION) {
        connection.status = "error";
        connection.error = String(message?.error || "IDEA bridge authentication failed.");
        closeConnection(connection, connection.error);
        return;
      }
      connection.authenticated = true;
      connection.status = "connected";
      connection.error = undefined;
      publish();
      void refreshSnapshot(connection).catch((error) => {
        connection.status = "error";
        connection.error = getErrorMessage(error);
        publish();
      });
      return;
    }
    if (message?.type === "response" && typeof message.requestId === "string") {
      const pending = connection.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      connection.pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(bridgeError(String(message.error?.code || "IDEA_ERROR"), String(message.error?.message || "IDEA operation failed.")));
      return;
    }
    if (message?.type === "event" && message.event === "snapshotChanged") {
      try {
        connection.snapshot = normalizeBridgeSnapshot(message.snapshot, connection.discovery);
        connection.error = undefined;
        publish();
      } catch (error) {
        connection.error = getErrorMessage(error);
        publish();
      }
    }
  }

  function handleData(connection, chunk) {
    connection.buffer += chunk.toString("utf8");
    if (connection.buffer.length > MAX_BUFFER_CHARS) {
      connection.status = "error";
      closeConnection(connection, "IDEA bridge sent an oversized message.");
      return;
    }
    let newline = connection.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = connection.buffer.slice(0, newline).trim();
      connection.buffer = connection.buffer.slice(newline + 1);
      if (line) {
        try {
          handleMessage(connection, JSON.parse(line));
        } catch (error) {
          connection.status = "error";
          closeConnection(connection, `IDEA bridge protocol error: ${getErrorMessage(error)}`);
          return;
        }
      }
      newline = connection.buffer.indexOf("\n");
    }
  }

  function connectBridge(connection) {
    if (stopped || connection.socket || !processAlive(connection.discovery.pid)) return;
    connection.status = "connecting";
    connection.error = undefined;
    publish();
    const socket = connect({ host: "127.0.0.1", port: connection.discovery.port });
    connection.socket = socket;
    socket.setNoDelay?.(true);
    socket.setTimeout?.(REQUEST_TIMEOUT_MS, () => {
      if (!connection.authenticated) {
        connection.status = "error";
        closeConnection(connection, "IDEA bridge authentication timed out.");
      }
    });
    socket.on("connect", () => {
      sendLine(connection, { type: "auth", protocolVersion: PROTOCOL_VERSION, token: connection.discovery.token });
    });
    socket.on("data", (chunk) => handleData(connection, chunk));
    socket.on("error", (error) => {
      connection.status = "error";
      closeConnection(connection, getErrorMessage(error));
    });
    socket.on("close", () => {
      if (connection.socket !== socket) return;
      connection.socket = undefined;
      connection.authenticated = false;
      settlePending(connection, bridgeError("IDEA_DISCONNECTED", "IDEA bridge disconnected."));
      if (!stopped && connection.status !== "error") connection.status = "disconnected";
      publish();
    });
  }

  async function readDiscoveries() {
    let names;
    try {
      names = await fsp.readdir(discoveryDir);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const now = Date.now();
    const discoveries = [];
    await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      const filePath = path.join(discoveryDir, name);
      try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile()) return;
        const raw = JSON.parse(await fsp.readFile(filePath, "utf8"));
        let discovery;
        try {
          discovery = validateDiscovery(raw, now);
        } catch (error) {
          const bridgeId = String(raw?.bridgeId || "").trim();
          const pid = Number(raw?.pid);
          const updatedAt = Number(raw?.updatedAt);
          if (error?.code !== "PROTOCOL_MISMATCH" || !/^[A-Za-z0-9_-]{12,128}$/.test(bridgeId)
            || !Number.isInteger(pid) || !processAlive(pid) || !Number.isFinite(updatedAt) || now - updatedAt > DISCOVERY_STALE_MS) return;
          discoveries.push({
            bridgeId,
            pid,
            updatedAt,
            protocolVersion: Number(raw.protocolVersion),
            productName: String(raw.productName || "IntelliJ IDEA"),
            productVersion: String(raw.productVersion || ""),
            buildNumber: String(raw.buildNumber || ""),
            token: "",
            port: 0,
            incompatible: true
          });
          return;
        }
        if (processAlive(discovery.pid)) discoveries.push(discovery);
      } catch {
        // Ignore partial, stale, incompatible, or untrusted records. A later scan retries atomic replacements.
      }
    }));
    return discoveries;
  }

  async function scan() {
    if (stopped) return;
    const discoveries = await readDiscoveries();
    const activeIds = new Set(discoveries.map((entry) => entry.bridgeId));
    for (const [bridgeId, connection] of connections) {
      if (!activeIds.has(bridgeId)) {
        closeConnection(connection, "IDEA bridge is no longer available.", false);
        connections.delete(bridgeId);
      }
    }
    for (const discovery of discoveries) {
      let connection = connections.get(discovery.bridgeId);
      if (!connection) {
        connection = {
          discovery,
          status: "disconnected",
          error: undefined,
          snapshot: undefined,
          socket: undefined,
          buffer: "",
          authenticated: false,
          pending: new Map()
        };
        connections.set(discovery.bridgeId, connection);
      } else {
        const endpointChanged = connection.discovery.port !== discovery.port || connection.discovery.token !== discovery.token;
        connection.discovery = discovery;
        if (endpointChanged) closeConnection(connection, undefined, false);
      }
      if (discovery.incompatible) {
        connection.status = "error";
        connection.error = `IDEA bridge protocol ${discovery.protocolVersion} is incompatible with protocol ${PROTOCOL_VERSION}.`;
      } else if (!connection.socket) {
        connectBridge(connection);
      }
    }
    publish();
  }

  async function runOperation(bridgeId, method, params) {
    const connection = connections.get(String(bridgeId || ""));
    if (!connection) throw bridgeError("IDEA_NOT_FOUND", "The selected IDEA instance is no longer available.");
    const result = await request(connection, method, params);
    setTimeout(() => void refreshSnapshot(connection).catch(() => {}), 250).unref?.();
    return result;
  }

  async function start() {
    if (stopped) throw new Error("IDEA bridge service has been stopped.");
    await fsp.mkdir(discoveryDir, { recursive: true });
    await scan();
    scanTimer = setInterval(() => void scan().catch(() => {}), scanIntervalMs);
    scanTimer.unref?.();
    pollTimer = setInterval(() => {
      for (const connection of connections.values()) {
        if (connection.status === "connected") void refreshSnapshot(connection).catch(() => {});
      }
    }, 5000);
    pollTimer.unref?.();
  }

  async function shutdown() {
    stopped = true;
    clearInterval(scanTimer);
    clearInterval(pollTimer);
    for (const connection of connections.values()) closeConnection(connection, "Pannel Handle is shutting down.", false);
    connections.clear();
  }

  return {
    start,
    shutdown,
    scan,
    getSnapshot,
    startConfiguration: (bridgeId, projectId, configurationId, mode) => runOperation(bridgeId, "start", { projectId, configurationId, mode }),
    stopExecution: (bridgeId, instanceId) => runOperation(bridgeId, "stop", { instanceId }),
    stopAll: (bridgeId, projectId, configurationId) => runOperation(bridgeId, "stopAll", { projectId, configurationId }),
    restartExecution: (bridgeId, instanceId) => runOperation(bridgeId, "restart", { instanceId })
  };
}

module.exports = {
  PROTOCOL_VERSION,
  createIdeaBridgeService,
  isProcessAlive,
  normalizeBridgeSnapshot,
  validateDiscovery
};
