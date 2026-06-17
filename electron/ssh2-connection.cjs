const fs = require("node:fs");
const { normalizeSshPort, validateSsh2Config } = require("./ssh-config-utils.cjs");

function buildSsh2ConnectionConfig({ sshConfig = {}, secret, knownHostStore, onHostVerification }) {
  validateSsh2Config(sshConfig);

  const host = String(sshConfig.host || "").trim();
  const port = normalizeSshPort(sshConfig.port);
  const username = String(sshConfig.username || "").trim() || undefined;
  const identityFile = String(sshConfig.identityFile || "").trim();
  const config = {
    host,
    port,
    username,
    readyTimeout: 15000,
    tryKeyboard: Boolean(secret),
    hostVerifier: (key) => {
      if (!knownHostStore || typeof knownHostStore.verifyHostKey !== "function") {
        return true;
      }
      const result = knownHostStore.verifyHostKey({
        host,
        port,
        key,
        algorithm: undefined
      });
      if (typeof onHostVerification === "function") {
        onHostVerification(result);
      }
      return result.accepted;
    }
  };

  if (identityFile) {
    config.privateKey = fs.readFileSync(identityFile);
    if (secret) {
      config.passphrase = secret;
    }
  } else if (secret) {
    config.password = secret;
  }

  return config;
}

module.exports = {
  buildSsh2ConnectionConfig,
  normalizeSshPort,
  validateSsh2Config
};
