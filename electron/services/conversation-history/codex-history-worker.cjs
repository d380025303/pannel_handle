const { parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { readLocalCodexList } = require("./local-codex-history.cjs");
const { filterAndPage } = require("./history-values.cjs");

const snapshots = new Map();
parentPort.on("message", ({ id, input }) => {
  try {
    const now = Date.now();
    for (const [key, entry] of snapshots) {
      if (now - entry.createdAt >= 30_000) snapshots.delete(key);
    }
    let snapshot = input.cursor !== null && input.cursor !== "" ? snapshots.get(input.cacheKey) : null;
    if (!snapshot) {
      const items = readLocalCodexList({ ...input, fsApi: fs, Database: DatabaseSync });
      snapshot = { items: [...items, ...input.items], errors: input.errors, createdAt: now };
      snapshots.delete(input.cacheKey);
      snapshots.set(input.cacheKey, snapshot);
      if (snapshots.size > 2) snapshots.delete(snapshots.keys().next().value);
    }
    parentPort.postMessage({ id, result: { ...filterAndPage(snapshot.items, input), errors: snapshot.errors } });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } });
  }
});
