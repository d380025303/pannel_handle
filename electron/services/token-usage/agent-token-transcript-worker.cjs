const { parentPort, workerData } = require("node:worker_threads");
const { parseTranscriptFileWithSubagents, parseTranscriptText, mergeTranscriptResults } = require("./agent-token-transcript.cjs");

function parseRemoteResponse(provider, response) {
  const payload = JSON.parse(response);
  if (provider === "codebuddy") {
    const results = payload.files.map(lines => parseTranscriptText(provider, lines.join("\n")));
    return results.length === 1 ? results[0] : mergeTranscriptResults(results);
  }
  return parseTranscriptText(provider, Array.isArray(payload) ? payload.join("\n") : "");
}

try {
  parentPort.postMessage({
    result: Object.hasOwn(workerData, "remoteResponse")
      ? parseRemoteResponse(workerData.provider, workerData.remoteResponse)
      : parseTranscriptFileWithSubagents(workerData.provider, workerData.transcriptPath)
  });
} catch (error) {
  parentPort.postMessage({ error: { name: error.name, message: error.message, code: error.code } });
}
