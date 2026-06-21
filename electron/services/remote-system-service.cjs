const { Client } = require("ssh2");
const { createSshSessionRuntime } = require("../ssh/ssh-session-runtime.cjs");

const SECTION_MARKER = "__PANNEL_HANDLE_SECTION__";
const VIRTUAL_FILESYSTEMS = new Set([
  "devtmpfs",
  "tmpfs",
  "squashfs",
  "proc",
  "sysfs",
  "cgroup",
  "cgroup2",
  "debugfs",
  "tracefs",
  "securityfs",
  "pstore",
  "configfs",
  "fusectl",
  "mqueue",
  "hugetlbfs",
  "ramfs",
  "autofs",
  "overlay",
  "nsfs"
]);

const LINUX_METRICS_COMMAND = [
  "export LC_ALL=C",
  `printf '${SECTION_MARKER} network\\n'`,
  "cat /proc/net/dev",
  `printf '${SECTION_MARKER} memory\\n'`,
  "cat /proc/meminfo",
  `printf '${SECTION_MARKER} disk\\n'`,
  "df -PTk 2>/dev/null || :"
].join("; ");

function splitSections(output) {
  const sections = {};
  let current;
  for (const line of String(output || "").split(/\r?\n/)) {
    if (line.startsWith(`${SECTION_MARKER} `)) {
      current = line.slice(SECTION_MARKER.length + 1).trim();
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  return sections;
}

function parseNetwork(lines = []) {
  let receivedBytes = 0;
  let transmittedBytes = 0;
  for (const line of lines) {
    const match = line.match(/^\s*([^:]+):\s*(.+)$/);
    if (!match || match[1].trim() === "lo") continue;
    const fields = match[2].trim().split(/\s+/).map(Number);
    if (fields.length < 9 || fields.some(Number.isNaN)) continue;
    receivedBytes += fields[0];
    transmittedBytes += fields[8];
  }
  return { receivedBytes, transmittedBytes };
}

function parseMemory(lines = []) {
  const values = {};
  for (const line of lines) {
    const match = line.match(/^(\w+):\s+(\d+)/);
    if (match) values[match[1]] = Number(match[2]) * 1024;
  }
  const totalBytes = values.MemTotal || 0;
  const availableBytes = values.MemAvailable ?? values.MemFree ?? 0;
  return {
    totalBytes,
    usedBytes: Math.max(0, totalBytes - availableBytes)
  };
}

function parseDisk(lines = []) {
  const disks = [];
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 7) continue;
    const [filesystem, type, blocks, used, available, capacity, ...mountParts] = fields;
    if (VIRTUAL_FILESYSTEMS.has(type)) continue;
    const totalBytes = Number(blocks) * 1024;
    const usedBytes = Number(used) * 1024;
    const availableBytes = Number(available) * 1024;
    const usedPercent = Number(String(capacity).replace("%", ""));
    if (![totalBytes, usedBytes, availableBytes, usedPercent].every(Number.isFinite)) continue;
    disks.push({
      filesystem,
      type,
      mountPoint: mountParts.join(" "),
      totalBytes,
      usedBytes,
      availableBytes,
      usedPercent
    });
  }
  return disks.sort((a, b) => b.usedPercent - a.usedPercent)[0];
}

function parseLinuxMetrics(output) {
  const sections = splitSections(output);
  return {
    network: parseNetwork(sections.network),
    memory: parseMemory(sections.memory),
    disk: parseDisk(sections.disk)
  };
}

function createRemoteSystemService({
  terminalManager,
  sessionStore,
  knownHostStore,
  sshSessionRuntime,
  clientFactory = () => new Client(),
  now = () => Date.now()
}) {
  const clients = new Map();
  const networkSamples = new Map();
  const sshRuntime = sshSessionRuntime || createSshSessionRuntime({
    terminalManager,
    sessionStore,
    knownHostStore,
    clientFactory
  });

  function getSession(sessionId) {
    const session = terminalManager.getSession(sessionId);
    if (!session) throw new Error("Session is not running.");
    if (session.type !== "ssh") throw new Error("Remote metrics are only available for SSH sessions.");
    return session;
  }

  function connect(sessionId) {
    const cached = clients.get(sessionId);
    if (cached) return cached.promise;

    getSession(sessionId);
    const entry = { client: null, promise: null };

    entry.promise = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        clients.delete(sessionId);
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      sshRuntime.connectClient(sessionId, { actionName: "SSH metrics connection" })
        .then((client) => {
          entry.client = client;
          client.on("close", () => {
            clients.delete(sessionId);
            networkSamples.delete(sessionId);
          });
          settled = true;
          resolve(client);
        })
        .catch(fail);
    });
    clients.set(sessionId, entry);
    return entry.promise;
  }

  async function exec(sessionId, command) {
    const client = await connect(sessionId);
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          void disconnect(sessionId);
          reject(err);
          return;
        }
        let stdout = "";
        let stderr = "";
        stream.on("data", (data) => {
          stdout += Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
        });
        stream.stderr?.on("data", (data) => {
          stderr += Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
        });
        stream.on("close", (code) => {
          if (Number.isInteger(code) && code !== 0) {
            reject(new Error(stderr.trim() || `Remote metrics command failed with exit code ${code}.`));
          } else {
            resolve(stdout);
          }
        });
      });
    });
  }

  async function getMetrics(sessionId) {
    getSession(sessionId);
    const parsed = parseLinuxMetrics(await exec(sessionId, LINUX_METRICS_COMMAND));
    const sampledAt = now();
    const previous = networkSamples.get(sessionId);
    const elapsedSeconds = previous ? (sampledAt - previous.sampledAt) / 1000 : 0;
    const receivedBytesPerSecond = elapsedSeconds > 0
      ? Math.max(0, (parsed.network.receivedBytes - previous.receivedBytes) / elapsedSeconds)
      : null;
    const transmittedBytesPerSecond = elapsedSeconds > 0
      ? Math.max(0, (parsed.network.transmittedBytes - previous.transmittedBytes) / elapsedSeconds)
      : null;
    networkSamples.set(sessionId, { sampledAt, ...parsed.network });

    return {
      sampledAt,
      network: { receivedBytesPerSecond, transmittedBytesPerSecond },
      memory: parsed.memory,
      disk: parsed.disk
    };
  }

  async function disconnect(sessionId) {
    const entry = clients.get(sessionId);
    clients.delete(sessionId);
    networkSamples.delete(sessionId);
    if (entry) {
      try {
        if (entry.client) {
          entry.client.end();
        } else {
          const client = await entry.promise.catch(() => undefined);
          client?.end?.();
        }
      } catch {
        // Ignore close failures during cleanup.
      }
    }
  }

  async function shutdown() {
    await Promise.all(Array.from(clients.keys()).map((id) => disconnect(id)));
  }

  return { getMetrics, disconnect, shutdown };
}

module.exports = {
  LINUX_METRICS_COMMAND,
  createRemoteSystemService,
  parseLinuxMetrics
};
