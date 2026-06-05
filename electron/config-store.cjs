const fs = require("node:fs");

function createConfigStore({ configFile }) {
  let config = {
    autoRestore: true,
    lastActiveSessionIds: []
  };

  function loadConfig() {
    try {
      const data = fs.readFileSync(configFile, "utf-8");
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = {
          autoRestore: typeof parsed.autoRestore === "boolean" ? parsed.autoRestore : true,
          lastActiveSessionIds: Array.isArray(parsed.lastActiveSessionIds)
            ? parsed.lastActiveSessionIds.filter(id => typeof id === "string")
            : []
        };
      }
    } catch (err) {
      if (err.code === "ENOENT") return;
      console.error("Failed to load config:", err);
    }
  }

  function saveConfig() {
    try {
      const data = JSON.stringify(config, null, 2);
      const tmpPath = configFile + ".tmp";
      fs.writeFileSync(tmpPath, data, "utf-8");
      fs.renameSync(tmpPath, configFile);
    } catch (err) {
      console.error("Failed to save config:", err);
    }
  }

  function getConfig() {
    return { ...config };
  }

  function updateConfig(partial) {
    if (partial && typeof partial === "object") {
      if (typeof partial.autoRestore === "boolean") {
        config.autoRestore = partial.autoRestore;
      }
      if (Array.isArray(partial.lastActiveSessionIds)) {
        config.lastActiveSessionIds = partial.lastActiveSessionIds.filter(id => typeof id === "string");
      }
    }
    saveConfig();
  }

  return {
    loadConfig,
    saveConfig,
    getConfig,
    updateConfig
  };
}

module.exports = {
  createConfigStore
};
