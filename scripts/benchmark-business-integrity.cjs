// Synthetic file-backed statistics; does not measure real Electron startup.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { createAgentTokenStatsStore } = require("../electron/services/token-usage/agent-token-stats-store.cjs");
const { createBusinessDataStore } = require("../electron/stores/business-data-store.cjs");
const { checkBusinessIntegrity } = require("../electron/stores/business-integrity-reader.cjs");

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "business-integrity-bench-"));
  const databaseFile = path.join(userData, "agent-token-stats.sqlite3");
  let db;
  try {
    const stats = createAgentTokenStatsStore({ databaseFile });
    stats.load();
    stats.close();
    const business = createBusinessDataStore({ userData });
    await business.openAsync();
    await business.close();
    db = new DatabaseSync(databaseFile);
    const columns = db.prepare("PRAGMA table_info(token_sessions)").all();
    const insert = db.prepare(`INSERT INTO token_sessions(${columns.map(c => c.name).join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
    const payload = JSON.stringify({ data: "x".repeat(3800) });
    let count = 0;
    for (const target of [100000, 300000]) {
      db.exec("BEGIN");
      for (; count < target; count++) {
        insert.run(...columns.map(c => {
          if (c.name === "id" || c.name === "agent_session_id") return String(count);
          if (c.name === "provider") return "codex";
          if (c.name === "status") return "ended";
          if (c.name === "raw_capabilities_json") return payload;
          if (c.name === "baseline_capabilities_json") return "{}";
          if (c.type === "INTEGER") return 0;
          return "";
        }));
      }
      db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
      let start = performance.now();
      assert.equal(Object.values(db.prepare("PRAGMA quick_check").get())[0], "ok");
      const synchronousMs = performance.now() - start;
      let ticks = 0;
      let previous = performance.now();
      let maxGapMs = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        maxGapMs = Math.max(maxGapMs, now - previous);
        previous = now;
        ticks++;
      }, 10);
      start = performance.now();
      try { await checkBusinessIntegrity(databaseFile); }
      finally { clearInterval(timer); }
      const workerMs = performance.now() - start;
      assert.ok(ticks > 5, "Main-thread timer must keep running during the check");
      console.log(JSON.stringify({ rows: target, MiB: +(fs.statSync(databaseFile).size / 1048576).toFixed(1), synchronousMs: +synchronousMs.toFixed(1), workerMs: +workerMs.toFixed(1), timerTicks: ticks, maxGapMs: +maxGapMs.toFixed(1) }));
    }
  } finally {
    db?.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
