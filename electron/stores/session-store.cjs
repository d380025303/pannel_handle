const { normalizeEntries } = require("../services/environment/index.cjs");
const { readJson, writeJson } = require("./business-store-io.cjs");
const os = require("node:os");
const { normalizeAdditionalDirectories } = require("../services/opencode-acp/additional-directories.cjs");

const AGENT_PROVIDERS = new Set(["claude", "codex", "codebuddy", "opencode", "qoder", "copilot", "gemini", "grok"]);
const LOCAL_BRIDGE_PROVIDERS = new Set(["codex", "codebuddy", "opencode", "claude", "qoder"]);
const CODEX_EXECUTION_PERMISSIONS = new Set(["readOnly", "askApproval", "fullAccess"]);
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

function createSessionStore({ environmentService, sessionsFile, getDefaultShell, getWslShell, safeStorage, templateUsageStore, launchTemplateStore, dataStore, getLegacyCodexAppServerEnabled = () => true, onChanged = () => {} }) {
  let librarySessions = [];
  let nextSessionId = 1;

  function encryptSecret(secret) {
    const value = String(secret || "");
    if (!value) {
      return undefined;
    }
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error("无法保存 SSH 密码：系统安全存储加密不可用。");
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
    const identityFile = String((Object.hasOwn(config, "identityFile")
      ? config.identityFile
      : existingConfig.identityFile) || "").trim() || undefined;
    const extraArgs = Array.isArray(config.extraArgs)
      ? config.extraArgs.map(arg => String(arg).trim()).filter(Boolean)
      : Array.isArray(existingConfig.extraArgs)
        ? existingConfig.extraArgs.map(arg => String(arg).trim()).filter(Boolean)
        : [];
    const remark = typeof config.remark === "string" ? config.remark.trim() : (existingConfig.remark || "");
    const requestedRemotePlatform = config.remotePlatform || existingConfig.remotePlatform;
    const remotePlatform = requestedRemotePlatform === "windows" || requestedRemotePlatform === "linux"
      ? requestedRemotePlatform
      : undefined;

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
      ...(remotePlatform ? { remotePlatform } : {}),
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
      ? (template.agentLocation === "local" && LOCAL_BRIDGE_PROVIDERS.has(agentProvider)
        && (agentProvider !== "claude" || template.graphicalSessionEnabled === true) ? "local" : "remote")
      : undefined;
    const localAgentCwd = template.type === "ssh" && LOCAL_BRIDGE_PROVIDERS.has(agentProvider) && agentLocation === "local" && typeof template.localAgentCwd === "string"
      ? template.localAgentCwd.trim() || undefined
      : undefined;
    const { normalizeModelSelection } = require("../services/model-sources/model-selection.cjs");
    const selection = normalizeModelSelection({ ...template, agentProvider });
    const { modelSource, modelId, codexBackend, codexModel } = selection;
    const codexExperimentalAcknowledged = (codexBackend === "openrouter" || codexBackend === "nararouter" || codexBackend === "minimax") && Boolean(codexModel) && template.codexExperimentalAcknowledged === true
      ? true
      : undefined;
    const graphicalSessionEnabled = typeof template.graphicalSessionEnabled === "boolean"
      ? template.graphicalSessionEnabled
      : agentProvider === "codex" ? template.codexAppServerEnabled !== false
      : agentProvider === "codebuddy" ? template.codeBuddyAcpEnabled === true
      : agentProvider === "opencode" ? template.openCodeAcpEnabled === true
      : agentProvider === "claude" ? false
      : agentProvider === "qoder" ? false
      : true;
    const codexAppServerModel = codexBackend === "openai" && typeof template.codexAppServerModel === "string"
      ? template.codexAppServerModel.trim() || undefined : undefined;
    const codexAppServerEffort = codexBackend === "openai" && typeof template.codexAppServerEffort === "string"
      ? template.codexAppServerEffort.trim() || undefined : undefined;
    const codexAppServerFastMode = codexBackend === "openai" ? template.codexAppServerFastMode === true : undefined;
    const codexExecutionPermission = agentProvider === "codex"
      ? (CODEX_EXECUTION_PERMISSIONS.has(template.codexExecutionPermission) ? template.codexExecutionPermission : "askApproval")
      : undefined;
    const savedCodeBuddyOptions = template.codeBuddyGraphicalOptions;
    const codeBuddyGraphicalOptions = savedCodeBuddyOptions && typeof savedCodeBuddyOptions === "object" && !Array.isArray(savedCodeBuddyOptions)
      ? {
          ...(typeof savedCodeBuddyOptions.mode === "string" && savedCodeBuddyOptions.mode.trim() ? { mode: savedCodeBuddyOptions.mode.trim() } : {}),
          ...(typeof savedCodeBuddyOptions.model === "string" && savedCodeBuddyOptions.model.trim() ? { model: savedCodeBuddyOptions.model.trim() } : {}),
          ...(typeof savedCodeBuddyOptions.contextWindow === "string" && savedCodeBuddyOptions.contextWindow.trim() ? { contextWindow: savedCodeBuddyOptions.contextWindow.trim() } : {}),
          ...(typeof savedCodeBuddyOptions.multitask === "boolean" ? { multitask: savedCodeBuddyOptions.multitask } : {})
        }
      : undefined;
    const savedOpenCodeOptions = template.openCodeGraphicalOptions;
    const openCodeGraphicalOptions = savedOpenCodeOptions && typeof savedOpenCodeOptions === "object" && !Array.isArray(savedOpenCodeOptions)
      ? {
          ...(typeof savedOpenCodeOptions.mode === "string" && savedOpenCodeOptions.mode.trim() ? { mode: savedOpenCodeOptions.mode.trim() } : {}),
          ...(typeof savedOpenCodeOptions.model === "string" && savedOpenCodeOptions.model.trim() ? { model: savedOpenCodeOptions.model.trim() } : {}),
          ...(typeof savedOpenCodeOptions.effort === "string" && savedOpenCodeOptions.effort.trim() ? { effort: savedOpenCodeOptions.effort.trim() } : {})
        }
      : undefined;
    return {
      ...(template.environmentProfileId ? { environmentProfileId: String(template.environmentProfileId) } : {}),
      ...(template.environmentOverrides ? { environmentOverrides: normalizeEntries(template.environmentOverrides, template.type === "windows" || (template.type === "ssh" && template.agentProvider && template.agentLocation === "local")) } : {}),
      id: template.id,
      title: template.title,
      shell: template.shell,
      cwd: template.cwd,
      fileSort,
      preferredDiskMountPoint: template.type === "ssh" && typeof template.preferredDiskMountPoint === "string" && template.preferredDiskMountPoint.trim()
        ? template.preferredDiskMountPoint.trim()
        : undefined,
      createdAt: template.createdAt,
      initialCommand: template.initialCommand,
      agentProvider,
      ...(agentProvider === "opencode" ? { openCodeAdditionalDirectories: normalizeAdditionalDirectories(template.openCodeAdditionalDirectories, { ...template, agentLocation }) } : {}),
      agentLocation,
      localAgentCwd,
      modelSource,
      modelId,
      codexBackend,
      codexModel,
      codexExperimentalAcknowledged,
      graphicalSessionEnabled,
      ...(agentProvider === "gemini" ? { geminiGraphicalConfigured: template.geminiGraphicalConfigured === true } : {}),
      ...(agentProvider === "grok" ? { grokGraphicalConfigured: template.grokGraphicalConfigured === true } : {}),
      codexAppServerModel,
      codexAppServerEffort,
      codexAppServerFastMode,
      codexExecutionPermission,
      codexPermissionProfileId: agentProvider === "codex" && typeof template.codexPermissionProfileId === "string" && template.codexPermissionProfileId.trim() && template.codexPermissionProfileId.length <= 512 && !template.codexPermissionProfileId.includes("\0") ? template.codexPermissionProfileId.trim() : undefined,
      ignoredCodexConfigWarnings: [...new Set((Array.isArray(template.ignoredCodexConfigWarnings) ? template.ignoredCodexConfigWarnings : []).filter(value => typeof value === "string" && value))],
      ...(codeBuddyGraphicalOptions && Object.keys(codeBuddyGraphicalOptions).length ? { codeBuddyGraphicalOptions } : {}),
      ...(openCodeGraphicalOptions && Object.keys(openCodeGraphicalOptions).length ? { openCodeGraphicalOptions } : {}),
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
      tags: normalizeTags(template.tags)
    });
  }

  function loadSessions() {
    try {
      const parsed = readJson(dataStore, sessionsFile);
      if (Array.isArray(parsed)) return parsed;
      return [];
    } catch (err) {
      if (err.code === "ENOENT") return [];
      console.error("Failed to load sessions:", err);
      return [];
    }
  }

  function migrateLegacyTemplate(template, legacyEnabled) {
    return {
      ...template,
      ...(template?.agentProvider === "gemini" && template.geminiGraphicalConfigured !== true
        ? { graphicalSessionEnabled: false, geminiGraphicalConfigured: true } : {}),
      ...(template?.agentProvider === "grok" && template.grokGraphicalConfigured !== true
        ? { graphicalSessionEnabled: false, grokGraphicalConfigured: true } : {}),
      ...(template?.agentProvider === "codex" && template.type !== "ssh" && typeof template.graphicalSessionEnabled !== "boolean" && typeof template.codexAppServerEnabled !== "boolean"
        ? { codexAppServerEnabled: legacyEnabled } : {}),
      ...(template?.agentProvider === "codex" && template.type === "ssh" && template.agentLocation === "local" && typeof template.graphicalSessionEnabled !== "boolean" && typeof template.codexAppServerEnabled !== "boolean"
        ? { codexAppServerEnabled: false } : {})
    };
  }

  function loadLibrary() {
    const saved = loadSessions();
    const legacyEnabled = getLegacyCodexAppServerEnabled();
    const needsMigration = saved.some(template => typeof template?.graphicalSessionEnabled !== "boolean"
      || template?.agentProvider === "gemini" && template.geminiGraphicalConfigured !== true
      || template?.agentProvider === "grok" && template.grokGraphicalConfigured !== true
      || "codexAppServerEnabled" in template || "codeBuddyAcpEnabled" in template || "openCodeAcpEnabled" in template);
    librarySessions = saved.map(template => normalizeTemplate(migrateLegacyTemplate(template, legacyEnabled)));
    for (const session of librarySessions) {
      bumpTemplateIdCounter(session.id);
    }
    if (needsMigration) saveLibrary();
    return librarySessions;
  }

  function saveLibrary(updated = librarySessions) {
    writeJson(dataStore, sessionsFile, updated);
    librarySessions = updated;
    try { onChanged(); }
    catch (err) { console.error("Failed to notify library change:", err); }
  }

  function addToLibrary(sessionMeta) {
    const template = normalizeTemplate(sessionMeta.agentProvider === "gemini"
      ? { ...sessionMeta, geminiGraphicalConfigured: true }
      : sessionMeta.agentProvider === "grok" ? { ...sessionMeta, grokGraphicalConfigured: true } : sessionMeta);
    const idx = librarySessions.findIndex(s => s.id === template.id);
    const updated = [...librarySessions];
    if (idx >= 0) {
      updated[idx] = { ...template, ignoredCodexConfigWarnings: librarySessions[idx].ignoredCodexConfigWarnings };
    } else {
      updated.push(template);
    }
    saveLibrary(updated);
  }

  function removeFromLibrary(id) {
    const updated = librarySessions.filter(s => s.id !== id);
    const removals = [
      launchTemplateStore?.prepareSessionTemplateRemoval?.(id),
      templateUsageStore?.prepareRemoval?.(id)
    ].filter(Boolean);
    if (removals.length) {
      if (!dataStore?.removeSessionTemplate || removals.some(removal => removal.dataStore !== dataStore)) {
        throw new Error("Deleting a session with related data requires a shared transactional data store.");
      }
      dataStore.removeSessionTemplate(sessionsFile, updated, removals);
      for (const removal of removals) removal.commit();
    } else {
      writeJson(dataStore, sessionsFile, updated);
    }
    librarySessions = updated;
    if (!launchTemplateStore?.prepareSessionTemplateRemoval) launchTemplateStore?.removeSessionTemplate(id);
    if (!templateUsageStore?.prepareRemoval) templateUsageStore?.remove(id);
    try { onChanged(); }
    catch (err) { console.error("Failed to notify library change:", err); }
  }

  function duplicateInLibrary(id) {
    const source = librarySessions.find(s => s.id === id);
    if (!source) {
      throw new Error(`Session template not found: ${id}`);
    }
    const duplicated = {
      ...serializeTemplate(source),
      id: String(nextSessionId),
      title: `${source.title} - 副本`,
      ignoredCodexConfigWarnings: [],
      createdAt: Date.now()
    };
    const updated = [...librarySessions, duplicated];
    writeJson(dataStore, sessionsFile, updated);
    librarySessions = updated;
    nextSessionId++;
    try { onChanged(); }
    catch (err) { console.error("Failed to notify library change:", err); }
    return sanitizeTemplate(duplicated);
  }

  function updateLibrary(id, updates) {
    const idx = librarySessions.findIndex(s => s.id === id);
    if (idx >= 0) {
      const nextUpdates = Object.fromEntries(
        Object.entries(updates).filter(([, value]) => typeof value !== "undefined")
      );
      const updated = [...librarySessions];
      updated[idx] = normalizeTemplate({
        ...librarySessions[idx],
        ...nextUpdates,
        ...(nextUpdates.agentProvider === "gemini" && typeof nextUpdates.graphicalSessionEnabled === "boolean"
          ? { geminiGraphicalConfigured: true } : {}),
        ...(librarySessions[idx].agentProvider === "grok" || nextUpdates.agentProvider === "grok"
          ? { grokGraphicalConfigured: true } : {}),
        sshConfig: nextUpdates.sshConfig
          ? normalizeSshConfig(nextUpdates.sshConfig, librarySessions[idx].sshConfig)
          : librarySessions[idx].sshConfig
      });
      writeJson(dataStore, sessionsFile, updated);
      librarySessions = updated;
      try { onChanged(); }
      catch (err) { console.error("Failed to notify library change:", err); }
    }
  }

  function setCodexPermissionProfile(id, profileId) {
    if (typeof profileId !== "string" || !profileId.trim() || profileId.length > 512 || profileId.includes("\0")) throw new Error("无效的权限档。");
    const index = librarySessions.findIndex(template => template.id === id && template.agentProvider === "codex");
    if (index < 0) throw new Error("Codex 会话模板不存在。");
    const updated = [...librarySessions];
    updated[index] = { ...updated[index], codexPermissionProfileId: profileId };
    writeJson(dataStore, sessionsFile, updated); librarySessions = updated;
    try { onChanged(); } catch (error) { console.error("Failed to notify library change:", error); }
  }

  function setCodexExecutionPermission(id, permission) {
    if (!CODEX_EXECUTION_PERMISSIONS.has(permission)) throw new Error("无效的 Codex 执行权限。");
    const idx = librarySessions.findIndex(session => session.id === id);
    if (idx < 0) throw new Error("会话模板不存在。");
    const template = librarySessions[idx];
    if (template.agentProvider !== "codex")
      throw new Error("会话模板不支持 Codex App Server。");
    const updated = [...librarySessions];
    updated[idx] = { ...template, codexExecutionPermission: permission, codexPermissionProfileId: undefined };
    writeJson(dataStore, sessionsFile, updated);
    librarySessions = updated;
    try { onChanged(); }
    catch (err) { console.error("Failed to notify library change:", err); }
  }

  function ignoreCodexConfigWarning(id, fingerprint) {
    if (typeof fingerprint !== "string" || !fingerprint || fingerprint.length > 65536)
      throw new Error("无效的配置警告标识。");
    const index = librarySessions.findIndex(template => template.id === id);
    if (index < 0) throw new Error("会话模板不存在。");
    const ignored = [...new Set([...librarySessions[index].ignoredCodexConfigWarnings, fingerprint])];
    const updated = [...librarySessions];
    updated[index] = { ...updated[index], ignoredCodexConfigWarnings: ignored };
    writeJson(dataStore, sessionsFile, updated);
    librarySessions = updated;
    try { onChanged(); } catch (err) { console.error("Failed to notify library change:", err); }
    return [...ignored];
  }

  function getLibrary() {
    const summaries = templateUsageStore?.getSummaries(librarySessions.map(session => session.id));
    return librarySessions.map((session) => ({
      ...sanitizeTemplate(session),
      ...(summaries?.get(String(session.id).trim()) || { recentLaunchCount: 0, lastLaunchedAt: undefined })
    }));
  }

  function exportLibrary(options = {}) {
    const includeEncryptedSecrets = options.includeEncryptedSecrets === true;
    return librarySessions.map((session) => (
      environmentService ? environmentService.snapshot(includeEncryptedSecrets ? serializeTemplate(session) : sanitizeTemplate(session)) : (includeEncryptedSecrets ? serializeTemplate(session) : sanitizeTemplate(session))
    ));
  }

  function importLibrary(items) {
    if (!Array.isArray(items)) {
      throw new Error("Imported sessions must be an array.");
    }

    const legacyEnabled = getLegacyCodexAppServerEnabled();
    const imported = [];
    let importedNextSessionId = nextSessionId;
    const usedIds = new Set(librarySessions.map(session => session.id));
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Each imported session must be an object.");
      }
      let id = String(importedNextSessionId++);
      while (usedIds.has(id)) {
        id = String(importedNextSessionId++);
      }
      usedIds.add(id);
      const template = normalizeTemplate({ ...migrateLegacyTemplate(item, legacyEnabled), id });
      imported.push(template);
    }

    if (imported.length > 0) {
      const updated = [...librarySessions, ...imported];
      writeJson(dataStore, sessionsFile, updated);
      librarySessions = updated;
      nextSessionId = importedNextSessionId;
      try { onChanged(); } catch (error) { console.error("Failed to notify library change:", error); }
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
    setCodexExecutionPermission,
    setCodexPermissionProfile,
    getLibrary,
    exportLibrary,
    importLibrary,
    getTemplate,
    ignoreCodexConfigWarning,
  };
}

module.exports = {
  createSessionStore,
  inferWorkingDirectory,
  normalizeTags
};
