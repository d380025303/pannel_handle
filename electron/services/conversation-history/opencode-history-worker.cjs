const { parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { readLocalOpenCodeMessages } = require("./local-opencode-history.cjs");

parentPort.on("message", ({ id, input }) => {
  try {
    const messages = readLocalOpenCodeMessages({ ...input, fsApi: fs, Database: DatabaseSync });
    messages.sort((left, right) => right.timestamp - left.timestamp);
    // Keep each structured clone on the main thread bounded.
    for (let offset = 0; offset < messages.length; offset += 128) {
      parentPort.postMessage({ id, chunk: messages.slice(offset, offset + 128) });
    }
    parentPort.postMessage({ id });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } });
  }
});
