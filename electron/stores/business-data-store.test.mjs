import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createBusinessDataStore, SOURCES } from "./business-data-store.cjs";
import { createConfigStore } from "./config-store.cjs";
import { createLaunchTemplateStore } from "./launch-template-store.cjs";

function fixture() {
  const userData = mkdtempSync(path.join(tmpdir(), "pannel-business-data-"));
  const databaseFile = path.join(userData, "agent-token-stats.sqlite3");
  return { userData, databaseFile, file: name => path.join(userData, name), open: () => createBusinessDataStore({ userData, databaseFile }).open() };
}

describe("business data SQLite migration", () => {
  it("imports every current source, preserves old files, and uses SQLite after restart", () => {
    const sample = {
      "sessions.json": [{ id: "s1", title: "SSH", sshConfig: { encryptedSecret: "ciphertext" } }],
      "config.json": { themeId: "light", sidebarWidth: 310 },
      "launch-templates.json": { schemaVersion: 1, launchTemplates: [{ id: "l1", name: "Daily", sessionTemplateIds: ["s1"] }] },
      "template-usage.json": { s1: [100, 200] },
      "environment-profiles.json": [{ id: "e1", name: "Dev", entries: [{ name: "A", value: "1" }] }],
      "openrouter.json": { encryptedApiKey: "ciphertext", favoriteModelIds: ["m1"], cachedModels: [{ id: "m1" }], modelVerifications: { m1: { status: "passed" } } },
      "nararouter.json": { favoriteModelIds: [] },
      "minimax.json": { favoriteModelIds: [] },
      "codebuddy-codex.json": { favoriteModelIds: ["c1"], cachedModels: [{ id: "c1" }] },
      "codebuddy-codex-verifications.json": { "v1:c1": { status: "passed" } },
      "dingtalk.json": { enabled: true, encryptedWebhook: "ciphertext" },
      "known-hosts.json": { "host:22": { fingerprint: "SHA256:test" } },
      "mobile-access.json": { schemaVersion: 1, config: { enabled: true }, devices: [{ id: "d1", encryptedToken: "ciphertext" }], audit: [{ id: "a1", type: "pair.approved" }] },
      "postgres-backup.json": { enabled: true, host: "localhost", password: "ciphertext" }
    };
    const fx = fixture();
    expect(Object.keys(sample).sort()).toEqual([...SOURCES].sort());
    for (const [name, value] of Object.entries(sample)) writeFileSync(fx.file(name), JSON.stringify(value));
    let store = fx.open();
    for (const [name, value] of Object.entries(sample)) expect(store.read(fx.file(name))).toEqual(value);
    store.write(fx.file("config.json"), { themeId: "dark-blue" });
    expect(JSON.parse(readFileSync(fx.file("config.json"), "utf8"))).toEqual(sample["config.json"]);
    store.close();

    store = fx.open();
    expect(store.read(fx.file("config.json"))).toEqual({ themeId: "dark-blue" });
    expect(store.read(fx.file("sessions.json"))).toEqual(sample["sessions.json"]);
    store.close();
  });

  it("rolls back the complete import when a source is invalid", () => {
    const fx = fixture();
    writeFileSync(fx.file("sessions.json"), JSON.stringify([{ id: "s1" }]));
    writeFileSync(fx.file("config.json"), "{ broken");
    expect(() => fx.open()).toThrow("Cannot migrate config.json");
    const db = new DatabaseSync(fx.databaseFile);
    expect(db.prepare("SELECT count(*) AS count FROM app_sources").get().count).toBe(0);
    expect(db.prepare("SELECT count(*) AS count FROM app_migrations").get().count).toBe(0);
    db.close();
    writeFileSync(fx.file("config.json"), JSON.stringify({ themeId: "light" }));
    const store = fx.open();
    expect(store.read(fx.file("sessions.json"))).toEqual([{ id: "s1" }]);
    store.close();
  });

  it("keeps the token-statistics schema version independent", () => {
    const fx = fixture();
    const db = new DatabaseSync(fx.databaseFile);
    db.exec("PRAGMA user_version=7");
    db.close();
    const store = fx.open();
    store.write(fx.file("known-hosts.json"), { "host:22": { fingerprint: "test" } });
    store.close();
    const reopened = new DatabaseSync(fx.databaseFile);
    expect(reopened.prepare("PRAGMA user_version").get().user_version).toBe(7);
    reopened.close();
  });

  it("routes existing store writes through SQLite without changing legacy JSON", () => {
    const fx = fixture();
    writeFileSync(fx.file("config.json"), JSON.stringify({ themeId: "light" }));
    const dataStore = fx.open();
    const config = createConfigStore({ configFile: fx.file("config.json"), dataStore });
    config.loadConfig();
    expect(config.getConfig().themeId).toBe("light");
    config.updateConfig({ themeId: "dark-blue" });
    const launch = createLaunchTemplateStore({ templatesFile: fx.file("launch-templates.json"), dataStore });
    launch.load();
    launch.create({ name: "Daily", sessionTemplateIds: ["s1"] });
    dataStore.close();

    const reopened = fx.open();
    const nextConfig = createConfigStore({ configFile: fx.file("config.json"), dataStore: reopened });
    nextConfig.loadConfig();
    expect(nextConfig.getConfig().themeId).toBe("dark-blue");
    const nextLaunch = createLaunchTemplateStore({ templatesFile: fx.file("launch-templates.json"), dataStore: reopened });
    expect(nextLaunch.load()).toEqual([expect.objectContaining({ name: "Daily", sessionTemplateIds: ["s1"] })]);
    expect(JSON.parse(readFileSync(fx.file("config.json"), "utf8"))).toEqual({ themeId: "light" });
    reopened.close();
  });
});
