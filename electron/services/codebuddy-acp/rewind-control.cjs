const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { randomUUID } = require("node:crypto");
const { sanitizeDiagnostic } = require("./http-transport.cjs");

const REWIND_SCOPES = new Set(["Code", "Conversation", "CodeAndConversation"]);
const ID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const isRewindMessageId = value => typeof value === "string" && ID_PATTERN.test(value);

function runRewindControl({ sessionId, messageId, scope, cwd, env, spawnProcess = spawn, timeoutMs = 60000 }) {
  if (!isRewindMessageId(sessionId) || !isRewindMessageId(messageId) || !REWIND_SCOPES.has(scope))
    return Promise.reject(new Error("无效的 CodeBuddy 回退目标。"));
  return new Promise((resolve, reject) => {
    const secrets = Object.entries(env || {}).filter(([name]) => /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(name))
      .map(([, value]) => value);
    const clean = value => sanitizeDiagnostic(value, secrets);
    const child = spawnProcess("cmd.exe", ["/d", "/s", "/c",
      `codebuddy -p --resume ${sessionId} --input-format stream-json --output-format stream-json`],
    { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const requestId = randomUUID();
    let settled = false;
    let stderr = "";
    const lines = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => finish(new Error("CodeBuddy 回退请求超时。")), timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      const stopped = new Promise((done, fail) => {
        if (child.exitCode != null) { done(); return; }
        const stopTimer = setTimeout(() => fail(new Error("等待 CodeBuddy 回退进程退出超时。")), 5000);
        child.once("exit", () => { clearTimeout(stopTimer); done(); });
        child.stdin.end();
        if (Number.isInteger(child.pid) && process.platform === "win32") {
          const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", () => child.kill());
        } else child.kill();
      });
      stopped.then(() => error ? reject(error) : resolve(value), stopError => reject(error || stopError));
    }
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-1000); });
    lines.on("line", line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      const response = event?.response;
      if (event?.type !== "control_response" || response?.request_id !== requestId) return;
      if (response.subtype !== "success" || response.response?.canRewind !== true)
        finish(new Error(clean(response.response?.error || stderr || "CodeBuddy 无法回退到所选消息。")));
      else finish(null, response.response);
    });
    child.once("error", finish);
    child.once("exit", code => finish(new Error(clean(`CodeBuddy 回退进程已退出（代码 ${code ?? "未知"}）。${stderr ? ` ${stderr}` : ""}`))));
    child.stdin.on("error", finish);
    child.stdin.write(JSON.stringify({ type: "control_request", request_id: requestId,
      request: { subtype: "rewind", user_message_id: messageId, scope } }) + "\n");
  });
}

module.exports = { isRewindMessageId, runRewindControl };
