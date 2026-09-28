const CODEBUDDY_ACP_INITIALIZE_ID = "pannel-handle-codebuddy-initialize";
const CODEBUDDY_USER_INFO_ID = "pannel-handle-codebuddy-user-info";
const { sanitizeDiagnostic } = require("../codebuddy-acp/http-transport.cjs");

function appendLimited(current, chunk, maxBytes) {
  const next = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk || "");
  const remaining = maxBytes - Buffer.byteLength(current, "utf-8");
  if (remaining <= 0) return current;
  return current + Buffer.from(next, "utf-8").subarray(0, remaining).toString("utf-8");
}

function runCodeBuddyUserInfoRequest(transport, {
  timeoutMs,
  maxOutputBytes
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";
    let outputBytes = 0;
    let userInfoRequested = false;
    const timer = setTimeout(() => finish(new Error("Reading CodeBuddy quota timed out.")), timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transport.close();
      if (error) reject(error); else resolve(result);
    }

    function handleMessage(message) {
      if (message?.id === CODEBUDDY_ACP_INITIALIZE_ID) {
        if (message.error) {
          finish(new Error("CodeBuddy ACP initialization failed."));
          return;
        }
        if (!message.result || userInfoRequested) return;
        userInfoRequested = true;
        transport.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: CODEBUDDY_USER_INFO_ID,
          method: "_codebuddy.ai/getUserInfo",
          params: {}
        })}\n`);
        return;
      }
      if (message?.id !== CODEBUDDY_USER_INFO_ID) return;
      if (message.error) {
        finish(new Error("CodeBuddy login information is unavailable."));
        return;
      }
      const userInfo = message?.result?.userInfo;
      const token = String(userInfo?.token || userInfo?.accessToken || "").trim();
      const userId = String(userInfo?.userId || "").trim();
      if (!token || !userId) {
        finish(new Error("Please sign in to CodeBuddy before reading quota."));
        return;
      }
      finish(undefined, { token, userId });
    }

    transport.on("stdout", chunk => {
      if (settled) return;
      outputBytes += Buffer.byteLength(Buffer.isBuffer(chunk) ? chunk : String(chunk || ""));
      if (outputBytes > maxOutputBytes) {
        finish(new Error("CodeBuddy ACP response exceeded the allowed size."));
        return;
      }
      stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk || "");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch {
          finish(new Error("CodeBuddy returned an invalid ACP response."));
          return;
        }
      }
    });
    transport.on("stderr", chunk => {
      stderr = appendLimited(stderr, chunk, 64 * 1024);
    });
    transport.on("error", () => finish(new Error("Unable to start CodeBuddy ACP.")));
    transport.on("close", code => {
      const detail = sanitizeDiagnostic(stderr).trim().slice(-500);
      finish(new Error(`CodeBuddy ACP exited before returning login information${Number.isInteger(code) ? ` (code ${code})` : ""}.${detail ? ` ${detail}` : ""}`));
    });

    transport.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: CODEBUDDY_ACP_INITIALIZE_ID,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "pannel-handle", version: "0.1.0" }
      }
    })}\n`);
  });
}

module.exports = {
  runCodeBuddyUserInfoRequest
};
