const { parentPort, workerData } = require("node:worker_threads");
const { StringDecoder } = require("node:string_decoder");
const { parseRipgrepMatch } = require("./ripgrep-search.cjs");
const { MAX_TEXT_RESULTS } = require("./search-limits.cjs");

const decoder = new StringDecoder("utf8");
let fragments = [];
const results = [];
let done = false;
function finish(reachedLimit = false) {
  if (done) return;
  done = true;
  fragments = [];
  parentPort.postMessage({ type: "done", results, reachedLimit });
}
function consumeLine() {
  const line = fragments.join("");
  fragments = [];
  if (!line) return;
  let event;
  try { event = JSON.parse(line); } catch { return; }
  const result = parseRipgrepMatch(event, workerData.session, workerData.displayRoot);
  if (result) results.push(result);
  if (results.length >= MAX_TEXT_RESULTS) finish(true);
}
function consume(text) {
  let start = 0;
  let end;
  while (!done && (end = text.indexOf("\n", start)) !== -1) {
    fragments.push(text.slice(start, end));
    consumeLine();
    start = end + 1;
  }
  if (!done && start < text.length) fragments.push(text.slice(start));
}
parentPort.on("message", (message) => {
  if (done) return;
  if (message.type === "chunk") {
    consume(typeof message.chunk === "string" ? message.chunk : decoder.write(Buffer.from(message.chunk)));
    if (!done) parentPort.postMessage({ type: "ack" });
  } else if (message.type === "end") {
    consume(decoder.end());
    if (!done) consumeLine();
    finish();
  }
});
