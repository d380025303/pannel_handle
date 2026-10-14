const { parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { readLocalOpenCodeMessages, readLocalOpenCodeList } = require("./local-opencode-history.cjs");

parentPort.on("message", ({ id, input, action = "messages" }) => {
  try {
    const messages = action === "list"
      ? readLocalOpenCodeList({ ...input, fsApi: fs, Database: DatabaseSync })
      : readLocalOpenCodeMessages({ ...input, fsApi: fs, Database: DatabaseSync });
    if (action !== "list") messages.sort((left, right) => right.timestamp - left.timestamp);
    // Keep each structured clone on the main thread bounded.
    for (let offset = 0; offset < messages.length; offset += 128) {
      parentPort.postMessage({ id, chunk: messages.slice(offset, offset + 128) });
    }
    parentPort.postMessage({ id });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } });
  }
});
