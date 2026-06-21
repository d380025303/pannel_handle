const fs = require("node:fs");
const crypto = require("node:crypto");

function createKnownHostStore({ knownHostsFile }) {
  let knownHosts = {};

  function loadKnownHosts() {
    try {
      const data = fs.readFileSync(knownHostsFile, "utf-8");
      const parsed = JSON.parse(data);
      knownHosts = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      if (err.code === "ENOENT") return;
      console.error("Failed to load known SSH hosts:", err);
      knownHosts = {};
    }
  }

  function saveKnownHosts() {
    try {
      const data = JSON.stringify(knownHosts, null, 2);
      const tmpPath = knownHostsFile + ".tmp";
      fs.writeFileSync(tmpPath, data, "utf-8");
      fs.renameSync(tmpPath, knownHostsFile);
    } catch (err) {
      console.error("Failed to save known SSH hosts:", err);
    }
  }

  function getHostKey(host, port) {
    return `${String(host || "").trim()}:${Number(port || 22)}`;
  }

  function createFingerprint(key) {
    return `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
  }

  function verifyHostKey({ host, port, key, algorithm }) {
    const hostKey = getHostKey(host, port);
    const fingerprint = createFingerprint(key);
    const existing = knownHosts[hostKey];
    const now = Date.now();

    if (!existing) {
      knownHosts[hostKey] = {
        algorithm,
        fingerprint,
        firstSeenAt: now,
        lastSeenAt: now
      };
      saveKnownHosts();
      return { accepted: true, trustedFirstUse: true, fingerprint };
    }

    if (existing.fingerprint !== fingerprint) {
      return {
        accepted: false,
        fingerprint,
        expectedFingerprint: existing.fingerprint
      };
    }

    knownHosts[hostKey] = {
      ...existing,
      algorithm: algorithm || existing.algorithm,
      lastSeenAt: now
    };
    saveKnownHosts();
    return { accepted: true, trustedFirstUse: false, fingerprint };
  }

  return {
    loadKnownHosts,
    saveKnownHosts,
    verifyHostKey
  };
}

module.exports = {
  createKnownHostStore
};
