const fs = require("node:fs");
const os = require("node:os");
const { sanitizeSshConfig } = require("./ssh-config-utils.cjs");

function inferWorkingDirectory(initialCommand, type) {
  const value = String(initialCommand || "").trim();
  const match = value.match(/^cd(?:\s+\/d)?\s+(?:"([^"]+)"|'([^']+)'|([^&;\r\n]+?))\s*(?:&&|;|$)/i);
  const cwd = (match?.[1] || match?.[2] || match?.[3] || "").trim();
  if (!cwd) return undefined;
  if (type === "wsl") return cwd.startsWith("/") ? cwd : undefined;
  return /^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith("\\\\") ? cwd : undefined;
}

function normalizeQuickCommands(commands) {
  if (!Array.isArray(commands)) return [];
  return commands.map((cmd) => ({
    ...cmd,
    mode: cmd.mode || 'write'
  }));
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  return tags.reduce((normalized, tag) => {
    const value = String(tag || "").trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return normalized;
    seen.add(key);
    normalized.push(value);
    return normalized;
  }, []);
}

function createSessionStore({ sessionsFile, getDefaultShell, getWslShell, safeStorage }) {
  let librarySessions = [];
  let nextSessionId = 1;

  function encryptSecret(secret) {
    const value = String(secret || "");
    if (!value) {
      return undefined;
    }
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      console.error("Failed to save SSH secret: Electron safeStorage encryption is not available.");
      return undefined;
    }
    return safeStorage.encryptString(value).toString("base64");
  }

  function decryptSecret(encryptedSecret) {
    const value = String(encryptedSecret || "");
    if (!value) {
      return undefined;
    }
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      console.error("Failed to read SSH secret: Electron safeStorage encryption is not available.");
      return undefined;
    }
    try {
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    } catch (err) {
      console.error("Failed to decrypt SSH secret:", err);
      return undefined;
    }
  }

  function normalizeSshConfig(config = {}, existingConfig = {}) {
    const host = String(config.host || existingConfig.host || "").trim();
    const username = String(config.username || existingConfig.username || "").trim();
    const parsedPort = Number(config.port || existingConfig.port || 22);
    const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 22;
    const identityFile = String(config.identityFile || existingConfig.identityFile || "").trim() || undefined;
    const remoteCommand = String(config.remoteCommand || existingConfig.remoteCommand || "").trim() || undefined;
    const extraArgs = Array.isArray(config.extraArgs)
      ? config.extraArgs.map(arg => String(arg).trim()).filter(Boolean)
      : Array.isArray(existingConfig.extraArgs)
        ? existingConfig.extraArgs.map(arg => String(arg).trim()).filter(Boolean)
        : [];
    const remark = typeof config.remark === "string" ? config.remark.trim() : (existingConfig.remark || "");

    const encryptedSecret = config.clearSecret
      ? undefined
      : typeof config.secret === "string" && config.secret
        ? encryptSecret(config.secret)
        : config.encryptedSecret || existingConfig.encryptedSecret;

    return {
      host,
      username,
      port,
      identityFile,
      remoteCommand,
      extraArgs,
      remark,
      encryptedSecret
    };
  }

  function sanitizeTemplate(template) {
    return {
      ...template,
      sshConfig: template.type === "ssh" ? sanitizeSshConfig(template.sshConfig) : undefined
    };
  }

  function serializeTemplate(template) {
    return {
      id: template.id,
      title: template.title,
      shell: template.shell,
      cwd: template.cwd,
      createdAt: template.createdAt,
      initialCommand: template.initialCommand,
      type: template.type,
      wslDistro: template.wslDistro,
      sshConfig: template.sshConfig,
      quickCommands: normalizeQuickCommands(template.quickCommands),
      tags: normalizeTags(template.tags)
    };
  }

  function bumpTemplateIdCounter(id) {
    const idNum = parseInt(id, 10);
    if (!isNaN(idNum) && idNum >= nextSessionId) {
      nextSessionId = idNum + 1;
    }
  }

  function createTemplateId() {
    return String(nextSessionId++);
  }

  function normalizeTemplate(template) {
    const type = template.type || (template.shell && template.shell.includes("wsl") ? "wsl" : "windows");
    const sshConfig = type === "ssh" ? normalizeSshConfig(template.sshConfig) : undefined;
    const inferredCwd = inferWorkingDirectory(template.initialCommand, type);
    const storedCwd = String(template.cwd || "").trim();
    const cwd = inferredCwd && (!storedCwd || storedCwd === os.homedir())
      ? inferredCwd
      : storedCwd || (type === "wsl" ? "~" : os.homedir());
    return serializeTemplate({
      ...template,
      type,
      shell: template.shell || (type === "wsl" ? getWslShell() : type === "ssh" ? "ssh2" : getDefaultShell()),
      cwd,
      createdAt: template.createdAt || Date.now(),
      sshConfig,
      quickCommands: normalizeQuickCommands(template.quickCommands),
      tags: normalizeTags(template.tags)
    });
  }

  function loadSessions() {
    try {
      const data = fs.readFileSync(sessionsFile, "utf-8");
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
      return [];
    } catch (err) {
      if (err.code === "ENOENT") return [];
      console.error("Failed to load sessions:", err);
      return [];
    }
  }

  function loadLibrary() {
    librarySessions = loadSessions().map(normalizeTemplate);
    for (const session of librarySessions) {
      bumpTemplateIdCounter(session.id);
    }
    return librarySessions;
  }

  function saveLibrary() {
    try {
      const data = JSON.stringify(librarySessions, null, 2);
      const tmpPath = sessionsFile + ".tmp";
      fs.writeFileSync(tmpPath, data, "utf-8");
      fs.renameSync(tmpPath, sessionsFile);
    } catch (err) {
      console.error("Failed to save library:", err);
    }
  }

  function addToLibrary(sessionMeta) {
    const template = normalizeTemplate(sessionMeta);
    const idx = librarySessions.findIndex(s => s.id === template.id);
    if (idx >= 0) {
      librarySessions[idx] = template;
    } else {
      librarySessions.push(template);
    }
    saveLibrary();
  }

  function removeFromLibrary(id) {
    librarySessions = librarySessions.filter(s => s.id !== id);
    saveLibrary();
  }

  function updateLibrary(id, updates) {
    const idx = librarySessions.findIndex(s => s.id === id);
    if (idx >= 0) {
      const nextUpdates = Object.fromEntries(
        Object.entries(updates).filter(([, value]) => typeof value !== "undefined")
      );
      librarySessions[idx] = normalizeTemplate({
        ...librarySessions[idx],
        ...nextUpdates,
        sshConfig: nextUpdates.sshConfig
          ? normalizeSshConfig(nextUpdates.sshConfig, librarySessions[idx].sshConfig)
          : librarySessions[idx].sshConfig
      });
      saveLibrary();
    }
  }

  function getLibrary() {
    return librarySessions.map(sanitizeTemplate);
  }

  function exportLibrary(options = {}) {
    const includeEncryptedSecrets = options.includeEncryptedSecrets === true;
    return librarySessions.map((session) => (
      includeEncryptedSecrets ? serializeTemplate(session) : sanitizeTemplate(session)
    ));
  }

  function importLibrary(items) {
    if (!Array.isArray(items)) {
      throw new Error("Imported sessions must be an array.");
    }

    const imported = [];
    const usedIds = new Set(librarySessions.map(session => session.id));
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Each imported session must be an object.");
      }
      let id = createTemplateId();
      while (usedIds.has(id)) {
        id = createTemplateId();
      }
      usedIds.add(id);
      const template = normalizeTemplate({
        ...item,
        id
      });
      imported.push(template);
    }

    if (imported.length > 0) {
      librarySessions.push(...imported);
      saveLibrary();
    }

    return {
      importedCount: imported.length,
      sessions: getLibrary()
    };
  }

  function getTemplate(id) {
    return librarySessions.find(item => item.id === id);
  }

  function reorderLibrary(orderedIds) {
    const sessionMap = new Map(librarySessions.map(s => [s.id, s]));
    const reordered = [];
    for (const id of orderedIds) {
      if (sessionMap.has(id)) {
        reordered.push(sessionMap.get(id));
        sessionMap.delete(id);
      }
    }
    for (const session of sessionMap.values()) {
      reordered.push(session);
    }
    librarySessions = reordered;
    saveLibrary();
  }

  return {
    createTemplateId,
    normalizeTemplate,
    sanitizeTemplate,
    decryptSecret,
    loadLibrary,
    saveLibrary,
    addToLibrary,
    removeFromLibrary,
    updateLibrary,
    getLibrary,
    exportLibrary,
    importLibrary,
    getTemplate,
    reorderLibrary
  };
}

module.exports = {
  createSessionStore,
  inferWorkingDirectory,
  normalizeTags
};
