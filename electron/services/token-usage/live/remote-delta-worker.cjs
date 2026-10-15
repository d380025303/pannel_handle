const { parentPort, workerData } = require("node:worker_threads");

try {
  const result = JSON.parse(workerData.output);
  const transfers = [];
  function decode(item) {
    if (!item || typeof item !== "object") return;
    // Use an owned ArrayBuffer, including for small deltas (no pooled Buffer copies).
    const data = String(item.data || "");
    const bytes = Buffer.alloc(Buffer.byteLength(data, "base64"));
    const length = bytes.write(data, "base64");
    item.data = new Uint8Array(bytes.buffer, bytes.byteOffset, length);
    transfers.push(bytes.buffer);
  }
  decode(result?.main);
  if (workerData.provider === "codebuddy" && Array.isArray(result?.subagents)) {
    for (const item of result.subagents) decode(item);
  } else if (result && typeof result === "object") {
    result.subagents = [];
  }
  parentPort.postMessage({ result }, transfers);
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
