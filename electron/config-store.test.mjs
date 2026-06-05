import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createConfigStore } = require("./config-store.cjs");

const tempDirs = [];

function createTempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-config-"));
  tempDirs.push(dir);
  return path.join(dir, "config.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("config-store", () => {
  it("defaults debugMode to false when config file is missing", () => {
    const store = createConfigStore({ configFile: createTempConfigPath() });

    store.loadConfig();

    expect(store.getConfig()).toEqual({
      autoRestore: true,
      debugMode: false,
      lastActiveSessionIds: []
    });
  });

  it("loads and persists debugMode", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({ autoRestore: false, debugMode: true }), "utf-8");
    const store = createConfigStore({ configFile });

    store.loadConfig();
    expect(store.getConfig().debugMode).toBe(true);

    store.updateConfig({ debugMode: false });
    const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(saved.debugMode).toBe(false);
  });
});
