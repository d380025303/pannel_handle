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
  `printf '${SECTION_MARKER} cpu\\n'`,
  "cat /proc/stat 2>/dev/null || :",
  `printf '${SECTION_MARKER} disk\\n'`,
  "df -PTk 2>/dev/null || :",
  `printf '${SECTION_MARKER} mountinfo\\n'`,
  "cat /proc/self/mountinfo 2>/dev/null || :",
  `printf '${SECTION_MARKER} diskio\\n'`,
  "cat /proc/diskstats 2>/dev/null || :"
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

function parseCpu(lines = []) {
  const line = lines.find((value) => /^cpu\s+/.test(value));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (fields.length < 4 || fields.some(Number.isNaN)) return null;
  const totalTicks = fields.reduce((sum, value) => sum + value, 0);
  const idleTicks = fields[3] + (fields[4] || 0);
  return { totalTicks, idleTicks };
}

function decodeMountField(value) {
  return String(value || "").replace(/\\([0-7]{3})/g, (_match, octal) => (
    String.fromCharCode(Number.parseInt(octal, 8))
  ));
}

function parseMountDevices(lines = []) {
  const devices = {};
  for (const line of lines) {
    const separatorIndex = line.indexOf(" - ");
    if (separatorIndex < 0) continue;
    const fields = line.slice(0, separatorIndex).trim().split(/\s+/);
    if (fields.length < 5 || !/^\d+:\d+$/.test(fields[2])) continue;
    devices[decodeMountField(fields[4])] = fields[2];
  }
  return devices;
}

function parseDiskIo(lines = []) {
  const devices = {};
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14) continue;
    const major = Number(fields[0]);
    const minor = Number(fields[1]);
    const readSectors = Number(fields[5]);
    const writeSectors = Number(fields[9]);
    const busyMilliseconds = Number(fields[12]);
    if (![major, minor, readSectors, writeSectors, busyMilliseconds].every(Number.isFinite)) continue;
    devices[`${major}:${minor}`] = {
      device: fields[2],
      readSectors,
      writeSectors,
      busyMilliseconds
    };
  }
  return devices;
}

function parseDisks(lines = []) {
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
  return disks.sort((a, b) => (
    b.usedPercent - a.usedPercent
    || a.mountPoint.localeCompare(b.mountPoint)
    || a.filesystem.localeCompare(b.filesystem)
  ));
}

function parseLinuxMetrics(output) {
  const sections = splitSections(output);
  return {
    network: parseNetwork(sections.network),
    memory: parseMemory(sections.memory),
    cpu: parseCpu(sections.cpu),
    disks: parseDisks(sections.disk),
    mountDevices: parseMountDevices(sections.mountinfo),
    diskIo: parseDiskIo(sections.diskio)
  };
}

function calculateRate(current, previous, elapsedSeconds, multiplier = 1) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || elapsedSeconds <= 0 || current < previous) {
    return null;
  }
  return ((current - previous) * multiplier) / elapsedSeconds;
}

function calculateCpuUsedPercent(current, previous) {
  if (!current || !previous) return null;
  const totalDelta = current.totalTicks - previous.totalTicks;
  const idleDelta = current.idleTicks - previous.idleTicks;
  if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) return null;
  return Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100));
}

function calculateDiskMetrics(current, previous, elapsedSeconds) {
  if (!current || !previous || elapsedSeconds <= 0) {
    return { busyPercent: null, readBytesPerSecond: null, writeBytesPerSecond: null };
  }
  const busyRate = calculateRate(current.busyMilliseconds, previous.busyMilliseconds, elapsedSeconds);
  return {
    busyPercent: busyRate === null ? null : Math.min(100, Math.max(0, busyRate / 10)),
    readBytesPerSecond: calculateRate(current.readSectors, previous.readSectors, elapsedSeconds, 512),
    writeBytesPerSecond: calculateRate(current.writeSectors, previous.writeSectors, elapsedSeconds, 512)
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
  const metricSamples = new Map();
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
            metricSamples.delete(sessionId);
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
    const previous = metricSamples.get(sessionId);
    const elapsedSeconds = previous ? (sampledAt - previous.sampledAt) / 1000 : 0;
    const receivedBytesPerSecond = calculateRate(
      parsed.network.receivedBytes,
      previous?.network.receivedBytes,
      elapsedSeconds
    );
    const transmittedBytesPerSecond = calculateRate(
      parsed.network.transmittedBytes,
      previous?.network.transmittedBytes,
      elapsedSeconds
    );
    metricSamples.set(sessionId, {
      sampledAt,
      network: parsed.network,
      cpu: parsed.cpu,
      diskIo: parsed.diskIo
    });

    return {
      sampledAt,
      network: { receivedBytesPerSecond, transmittedBytesPerSecond },
      memory: parsed.memory,
      cpu: { usedPercent: calculateCpuUsedPercent(parsed.cpu, previous?.cpu) },
      disks: parsed.disks.map((disk) => {
        const deviceKey = parsed.mountDevices[disk.mountPoint];
        return {
          ...disk,
          io: calculateDiskMetrics(
            deviceKey ? parsed.diskIo[deviceKey] : undefined,
            deviceKey ? previous?.diskIo?.[deviceKey] : undefined,
            elapsedSeconds
          )
        };
      })
    };
  }

  async function disconnect(sessionId) {
    const entry = clients.get(sessionId);
    clients.delete(sessionId);
    metricSamples.delete(sessionId);
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
  calculateCpuUsedPercent,
  calculateDiskMetrics,
  createRemoteSystemService,
  parseLinuxMetrics
};
