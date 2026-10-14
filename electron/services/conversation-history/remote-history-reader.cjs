const { spawn: defaultSpawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { deflateSync } = require("node:zlib");
const { REMOTE_TIMEOUT_MS, MAX_REMOTE_OUTPUT_BYTES } = require("./history-limits.cjs");

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function runProcess(command, args, spawn = defaultSpawn) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const stdoutDecoder = new StringDecoder("utf8");
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Agent conversation history query timed out."));
    }, REMOTE_TIMEOUT_MS);
    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      stdout += stdoutDecoder.write(chunk);
      if (stdoutBytes > MAX_REMOTE_OUTPUT_BYTES) child.kill();
    });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf-8"); });
    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout += stdoutDecoder.end();
      if (code === 0 && stdoutBytes <= MAX_REMOTE_OUTPUT_BYTES) resolve(stdout);
      else reject(new Error(stderr.trim() || "Agent conversation history query failed."));
    });
  });
}

function createRemoteHistoryReader({ fsApi, remoteScriptFile, spawn = defaultSpawn, sshAgentTransport }) {
  async function runRemote(session, action, input) {
    const script = fsApi.readFileSync(remoteScriptFile);
    // Keep the inline script below Windows' command-line limit as readers grow.
    const expression = `import base64,zlib;exec(zlib.decompress(base64.b64decode("${deflateSync(script).toString("base64")}")))`;
    const payload = Buffer.from(JSON.stringify(input), "utf-8").toString("base64");
    const output = session.type === "wsl"
      ? await runProcess("wsl.exe", ["-d", session.wslDistro, "--", "python3", "-c", expression, action, payload], spawn)
      : await sshAgentTransport.exec(
        session.id,
        `python3 -c ${shellQuote(expression)} ${shellQuote(action)} ${shellQuote(payload)}`,
        { actionName: "Agent conversation history", timeoutMs: REMOTE_TIMEOUT_MS }
      );
    try {
      return JSON.parse(output);
    } catch {
      throw new Error("Agent conversation history returned an invalid response.");
    }
  }

  return runRemote;
}

module.exports = {
  createRemoteHistoryReader
};
