const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { buildAgentModelEnvironment } = require("./agent-model-runtime.cjs");
const { sanitizeDiagnostic } = require("../codebuddy-acp/http-transport.cjs");

function runAgentModelProbe({ agent, providerId, modelId, baseUrl, apiKey, apiKeyEnv }, { spawnProcess = spawn, timeoutMs = 60000, probeToken = randomUUID() } = {}) {
  if (!/^[\w./:+-]+$/.test(modelId)) throw new Error("模型 ID 包含不支持的字符。");
  const runtimeEnv = buildAgentModelEnvironment(agent, { providerId, providerName: providerId, model: modelId, baseUrl, apiKey, apiKeyEnv });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-model-probe-"));
  fs.writeFileSync(path.join(cwd, "proof.txt"), probeToken, "utf8");
  const prompt = "Read proof.txt with your file reading tool. Reply with only its exact contents.";
  const args = agent === "opencode"
    ? ["run", "--standalone", "--model", `${providerId}/${modelId}`, prompt]
    : ["--print", "--allowedTools", "Read", "--model", modelId, prompt];
  const executable = agent === "opencode" ? "opencode" : "codebuddy";
  const windowsCommand = `${executable} ${agent === "opencode" ? "run --standalone" : "--print --allowedTools Read"} --model ${agent === "opencode" ? `${providerId}/${modelId}` : modelId} "${prompt}"`;
  return new Promise(resolve => {
    const env = { ...process.env, ...runtimeEnv };
    if (agent === "codebuddy") delete env.CODEBUDDY_AUTH_TOKEN;
    const safeOutput = value => sanitizeDiagnostic(String(value || "").replaceAll(apiKey, "[redacted]"),
      Object.entries(env).filter(([name]) => /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i.test(name)).map(([, value]) => value));
    let child;
    try {
      child = spawnProcess(process.platform === "win32" ? "cmd.exe" : executable,
        process.platform === "win32" ? ["/d", "/s", "/c", windowsCommand] : args,
        { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
      resolve({ status: "unavailable", error: sanitizeDiagnostic(String(error?.message || error), [apiKey]).slice(0, 500) });
      return;
    }
    let output = "";
    let settled = false;
    const finish = (result) => { if (settled) { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} return; } settled = true; clearTimeout(timer);
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
      resolve(result); };
    const timer = setTimeout(() => {
      if (process.platform === "win32" && Number.isInteger(child.pid)) spawnProcess("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      else child.kill();
      finish({ status: "unavailable", error: `${executable} 模型验证超时。` });
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => { output = (output + chunk.toString()).slice(-2000); });
    child.on("error", error => finish({ status: "unavailable", error: safeOutput(error.message || error).slice(0, 500) }));
    child.on("exit", code => finish(code === 0 && output.includes(probeToken)
      ? { status: "passed" }
      : { status: "failed", error: safeOutput(output).trim().slice(-800) || `${executable} 未完成文件读取验证（退出代码 ${code}）。` }));
  });
}

module.exports = { runAgentModelProbe };
