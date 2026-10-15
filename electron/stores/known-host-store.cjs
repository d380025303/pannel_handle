const { readJson, writeJson } = require("./business-store-io.cjs");
const crypto = require("node:crypto");

function createKnownHostStore({ knownHostsFile, dataStore }) {
  let knownHosts = {};

  function loadKnownHosts() {
    try {
      const parsed = readJson(dataStore, knownHostsFile);
      knownHosts = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      if (err.code === "ENOENT") return;
      console.error("Failed to load known SSH hosts:", err);
      knownHosts = {};
    }
  }

  function saveKnownHosts(records = knownHosts) {
    try {
      writeJson(dataStore, knownHostsFile, records);
      return { saved: true };
    } catch (err) {
      console.error("Failed to save known SSH hosts:", err);
      return { saved: false, error: `Failed to save SSH host fingerprint: ${err.message || String(err)}` };
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
      const candidate = {
        ...knownHosts,
        [hostKey]: {
          algorithm,
          fingerprint,
          firstSeenAt: now,
          lastSeenAt: now
        }
      };
      const result = saveKnownHosts(candidate);
      if (!result.saved) {
        return { accepted: false, fingerprint, error: result.error };
      }
      knownHosts = candidate;
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
