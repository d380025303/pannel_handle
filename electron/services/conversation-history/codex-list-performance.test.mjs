import { it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import history from "./agent-conversation-history-service.cjs";
import codex from "./local-codex-history.cjs";
import values from "./history-values.cjs";

it("pages large Codex lists off-thread, preserves snapshots and matches filtering and mixed sorting", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-list-worker-"));
  const root = path.join(homeDir, ".codex");
  fs.mkdirSync(root);
  const database = new DatabaseSync(path.join(root, "state_5.sqlite"));
  database.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, created_at INTEGER,
    updated_at INTEGER, archived INTEGER, first_user_message TEXT, preview TEXT, source TEXT,
    recency_at_ms INTEGER, updated_at_ms INTEGER)`);
  const insert = database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  database.exec("BEGIN");
  for (let i = 0; i < 10000; i++) insert.run(String(i), i % 3 ? "C:\\work" : "C:\\other",
    `title ${i}`, 100, 100 + i, i % 5 === 0 ? 1 : 0, "x".repeat(4096), "", i % 7 ? "cli" : "subagent", i, i);
  database.exec("COMMIT");
  const session = { id: "panel", type: "windows", cwd: "c:/WORK/" };
  const service = history.createAgentConversationHistoryService({ homeDir });
  try {
    for (const scope of ["all", "cwd"]) for (const includeArchived of [true, false]) {
      const request = { providers: ["codex"], scope, includeArchived, limit: 50, query: "" };
      const expected = codex.readLocalCodexList({ homeDir, cwd: session.cwd, scope, includeArchived, fsApi: fs });
      for (let run = 0; run < 3; run++) {
        let beats = 0;
        let zeroTimer = false;
        const timer = setInterval(() => beats++, 1);
        const zero = setTimeout(() => { zeroTimer = true; }, 0);
        const start = performance.now();
        let page;
        try { page = await service.listHistoryForSession(session, request); }
        finally { clearInterval(timer); clearTimeout(zero); }
        expect(page).toEqual({ ...values.filterAndPage(expected, request), errors: [] });
        expect(beats).toBeGreaterThan(0);
        expect(zeroTimer).toBe(true);
        console.log(`Codex list ${scope}/${includeArchived} run ${run + 1}: ${(performance.now() - start).toFixed(1)} ms, ${beats} heartbeats`);
      }
      database.prepare("UPDATE threads SET title = 'changed' WHERE id = '9999'").run();
      expect(await service.listHistoryForSession(session, { ...request, cursor: "50" })).toEqual({
        ...values.filterAndPage(expected, { ...request, cursor: "50" }), errors: [] });
      const searched = { ...request, query: "title 98" };
      const fresh = codex.readLocalCodexList({ homeDir, cwd: session.cwd, scope, includeArchived, fsApi: fs });
      expect(await service.listHistoryForSession(session, searched)).toEqual({
        ...values.filterAndPage(fresh, searched), errors: [] });
    }
    const buddyRoot = path.join(homeDir, ".codebuddy", "projects", "work");
    fs.mkdirSync(buddyRoot, { recursive: true });
    fs.writeFileSync(path.join(buddyRoot, "buddy.jsonl"), JSON.stringify({ id: "b", timestamp: 9999999999999,
      type: "message", role: "user", content: [{ type: "input_text", text: "buddy" }], cwd: session.cwd }));
    const mixed = await service.listHistoryForSession(session, { providers: ["codex", "codebuddy"], scope: "all", limit: 1 });
    expect(mixed.items[0].provider).toBe("codebuddy");
    expect((await service.listHistoryForSession(session, { providers: ["codex", "codebuddy"], scope: "all", limit: 1, cursor: mixed.nextCursor })).items[0].provider).toBe("codex");
  } finally {
    database.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}, 30000);
