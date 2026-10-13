const fs = require("node:fs");
const { parentPort } = require("node:worker_threads");
const { parseGrokMessages } = require("./local-grok-history.cjs");

parentPort.on("message", ({ id, transcriptPath, text }) => {
  try {
    const messages = transcriptPath && !fs.existsSync(transcriptPath)
      ? []
      : parseGrokMessages(transcriptPath ? fs.readFileSync(transcriptPath, "utf-8") : text);
    parentPort.postMessage({ id, messages });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } });
  }
});
