const { parentPort } = require("node:worker_threads");
const { parseGeminiRecords, materializeGeminiMessages } = require("./local-gemini-history.cjs");
const { timestampMs } = require("./history-values.cjs");

parentPort.on("message", ({ id, bytes, filePath }) => {
  try {
    const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf-8");
    const messages = materializeGeminiMessages(parseGeminiRecords(text, filePath)).flatMap(item => {
      const text = typeof item.content === "string" ? item.content.trim() : "";
      if (!text) return [];
      return [{ id: String(item.id), provider: "gemini", kind: item.type === "user" ? "user" : "reply", text, timestamp: timestampMs(item.timestamp) }];
    });
    messages.sort((left, right) => right.timestamp - left.timestamp);
    // Bound structured-clone work on the main thread, even for large transcripts.
    for (let offset = 0; offset < messages.length; offset += 128) {
      parentPort.postMessage({ id, chunk: messages.slice(offset, offset + 128) });
    }
    parentPort.postMessage({ id, messages: [] });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } });
  }
});
