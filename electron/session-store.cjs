const fs = require("node:fs");
const os = require("node:os");

function createSessionStore({ sessionsFile, getDefaultShell, getWslShell }) {
  let librarySessions = [];
  let nextSessionId = 1;

  function serializeTemplate(template) {
    return {
      id: template.id,
      title: template.title,
      shell: template.shell,
      cwd: template.cwd,
      createdAt: template.createdAt,
      initialCommand: template.initialCommand,
      type: template.type,
      wslDistro: template.wslDistro
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
    return serializeTemplate({
      ...template,
      type,
      shell: template.shell || (type === "wsl" ? getWslShell() : getDefaultShell()),
      cwd: template.cwd || os.homedir(),
      createdAt: template.createdAt || Date.now()
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
      librarySessions[idx] = normalizeTemplate({ ...librarySessions[idx], ...nextUpdates });
      saveLibrary();
    }
  }

  function getLibrary() {
    return librarySessions;
  }

  function getTemplate(id) {
    return librarySessions.find(item => item.id === id);
  }

  return {
    createTemplateId,
    normalizeTemplate,
    loadLibrary,
    saveLibrary,
    addToLibrary,
    removeFromLibrary,
    updateLibrary,
    getLibrary,
    getTemplate
  };
}

module.exports = {
  createSessionStore
};
