const fs = require("node:fs");
const os = require("node:os");

const AGENT_PROVIDERS = new Set(["claude", "codex", "opencode", "qoder"]);
const { sanitizeSshConfig } = require("../ssh/ssh-config-utils.cjs");

function inferWorkingDirectory(initialCommand, type) {
  const value = String(initialCommand || "").trim();
  const match = value.match(/^cd(?:\s+\/d)?\s+(?:"([^"]+)"|'([^']+)'|([^&;\r\n]+?))\s*(?:&&|;|$)/i);
  const cwd = (match?.[1] || match?.[2] || match?.[3] || "").trim();
  if (!cwd) return undefined;
  if (type === "wsl" || type === "ssh") return cwd.startsWith("/") ? cwd : undefined;
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

function createSessionStore({ sessionsFile, getDefaultShell, getWslShell, safeStorage, templateUsageStore, launchTemplateStore }) {
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
    const fileSortKeys = new Set(["name", "modifiedAt", "size"]);
    const fileSort = template.fileSort && fileSortKeys.has(template.fileSort.key)
      ? { key: template.fileSort.key, direction: template.fileSort.direction === "desc" ? "desc" : "asc" }
      : { key: "name", direction: "asc" };
    const agentProvider = AGENT_PROVIDERS.has(template.agentProvider) ? template.agentProvider : undefined;
    const agentLocation = template.type === "ssh" && agentProvider
      ? (template.agentLocation === "local" && agentProvider === "codex" ? "local" : "remote")
      : undefined;
    return {
      id: template.id,
      title: template.title,
      shell: template.shell,
      cwd: template.cwd,
      fileRoot: typeof template.fileRoot === "string" && template.fileRoot.trim() ? template.fileRoot.trim() : undefined,
      fileSort,
      createdAt: template.createdAt,
      initialCommand: template.initialCommand,
      agentProvider,
      agentLocation,
      type: template.type,
      wslDistro: template.wslDistro,
      sshConfig: template.sshConfig,
      quickCommands: normalizeQuickCommands(template.quickCommands),
      tags: normalizeTags(template.tags),
      gitCwd: typeof template.gitCwd === "string" && template.gitCwd.trim() ? template.gitCwd.trim() : undefined,
      gitCwdHistory: Array.isArray(template.gitCwdHistory)
        ? template.gitCwdHistory.filter(item => typeof item === "string" && item.trim()).map(item => item.trim()).slice(0, 10)
        : []
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
    const legacySshRemoteCommand = type === "ssh" ? String(template.sshConfig?.remoteCommand || "").trim() : "";
    const initialCommand = String(template.initialCommand || "").trim() || legacySshRemoteCommand || undefined;
    const inferredCwd = inferWorkingDirectory(initialCommand, type);
    const storedCwd = String(template.cwd || "").trim();
    const cwd = type === "ssh"
      ? (storedCwd && storedCwd !== os.homedir() ? storedCwd : "~")
      : inferredCwd && (!storedCwd || storedCwd === os.homedir())
        ? inferredCwd
        : storedCwd || (type === "wsl" ? "~" : os.homedir());
    return serializeTemplate({
      ...template,
      type,
      shell: template.shell || (type === "wsl" ? getWslShell() : type === "ssh" ? "ssh2" : getDefaultShell()),
      cwd,
      createdAt: template.createdAt || Date.now(),
      initialCommand,
      sshConfig,
      quickCommands: normalizeQuickCommands(template.quickCommands),
      tags: normalizeTags(template.tags),
      gitCwd: typeof template.gitCwd === "string" && template.gitCwd.trim() ? template.gitCwd.trim() : undefined,
      gitCwdHistory: Array.isArray(template.gitCwdHistory) ? template.gitCwdHistory : []
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
    templateUsageStore?.remove(id);
    saveLibrary();
    launchTemplateStore?.removeSessionTemplate(id);
  }

  function duplicateInLibrary(id) {
    const source = librarySessions.find(s => s.id === id);
    if (!source) {
      throw new Error(`Session template not found: ${id}`);
    }
    const duplicated = {
      ...serializeTemplate(source),
      id: createTemplateId(),
      title: `${source.title} - 副本`,
      createdAt: Date.now()
    };
    librarySessions.push(duplicated);
    saveLibrary();
    return sanitizeTemplate(duplicated);
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
    return librarySessions.map((session) => ({
      ...sanitizeTemplate(session),
      ...(templateUsageStore?.getSummary(session.id) || { recentLaunchCount: 0, lastLaunchedAt: undefined })
    }));
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

  return {
    createTemplateId,
    normalizeTemplate,
    sanitizeTemplate,
    decryptSecret,
    loadLibrary,
    saveLibrary,
    addToLibrary,
    removeFromLibrary,
    duplicateInLibrary,
    updateLibrary,
    getLibrary,
    exportLibrary,
    importLibrary,
    getTemplate,
  };
}

module.exports = {
  createSessionStore,
  inferWorkingDirectory,
  normalizeTags
};
