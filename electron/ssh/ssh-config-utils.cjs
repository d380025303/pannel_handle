function normalizeSshPort(value) {
  const parsedPort = Number(value || 22);
  return Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 22;
}

function validateSsh2Config(sshConfig = {}) {
  const host = String(sshConfig.host || "").trim();
  if (!host) {
    throw new Error("SSH host is required.");
  }
  if (Array.isArray(sshConfig.extraArgs) && sshConfig.extraArgs.length > 0) {
    throw new Error("SSH extra arguments are not supported by the ssh2 backend.");
  }
}

function sanitizeSshConfig(sshConfig) {
  if (!sshConfig) {
    return undefined;
  }
  const { secret, encryptedSecret, clearSecret, ...safeConfig } = sshConfig;
  return {
    ...safeConfig,
    hasSecret: Boolean(encryptedSecret)
  };
}

module.exports = {
  normalizeSshPort,
  sanitizeSshConfig,
  validateSsh2Config
};
