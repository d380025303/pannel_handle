import { mkdtempSync, rmSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createBusinessDataStore } from "./business-data-store.cjs";

it("awaits a read-only Worker check, including uncheckpointed WAL data", async () => {
  const userData = mkdtempSync(path.join(tmpdir(), "business-integrity-"));
  const databaseFile = path.join(userData, "agent-token-stats.sqlite3");
  const writer = new DatabaseSync(databaseFile);
  let store;
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE statistics(value INTEGER); INSERT INTO statistics VALUES(42)");
    store = createBusinessDataStore({ userData });
    expect(await store.openAsync()).toBe(store);
    expect(writer.prepare("SELECT value FROM statistics").get().value).toBe(42);
  } finally {
    await store?.close();
    writer.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

it("rejects physical corruption in a shared statistics table and closes the store", async () => {
  const userData = mkdtempSync(path.join(tmpdir(), "business-corrupt-"));
  const databaseFile = path.join(userData, "agent-token-stats.sqlite3");
  const seed = createBusinessDataStore({ userData }).open();
  await seed.close();
  const db = new DatabaseSync(databaseFile);
  db.exec("CREATE TABLE statistics(payload TEXT); INSERT INTO statistics VALUES('value'); PRAGMA wal_checkpoint(TRUNCATE)");
  const root = db.prepare("SELECT rootpage FROM sqlite_master WHERE name='statistics'").get().rootpage;
  const pageSize = db.prepare("PRAGMA page_size").get().page_size;
  db.close();
  const file = openSync(databaseFile, "r+");
  writeSync(file, Buffer.from([0]), 0, 1, (root - 1) * pageSize);
  closeSync(file);
  const store = createBusinessDataStore({ userData });
  try {
    await expect(store.openAsync()).rejects.toThrow("Business database failed integrity check");
    expect(() => store.read("config.json")).toThrow("not open");
  } finally {
    await store.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

it("propagates asynchronous migration errors without making the store available", async () => {
  const userData = mkdtempSync(path.join(tmpdir(), "business-migration-error-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path.join(userData, "config.json"), "{ broken");
  const store = createBusinessDataStore({ userData });
  try {
    await expect(store.openAsync()).rejects.toThrow("Cannot migrate config.json");
    expect(() => store.read("config.json")).toThrow("not open");
  } finally {
    await store.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
