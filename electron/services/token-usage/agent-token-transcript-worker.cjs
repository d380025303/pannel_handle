const { parentPort, workerData } = require("node:worker_threads");
const { parseTranscriptFileWithSubagents } = require("./agent-token-transcript.cjs");

try {
  parentPort.postMessage({
    result: parseTranscriptFileWithSubagents(workerData.provider, workerData.transcriptPath)
  });
} catch (error) {
  parentPort.postMessage({ error: { name: error.name, message: error.message, code: error.code } });
}
