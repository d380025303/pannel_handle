const fs = require("node:fs");
const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");

const GEMINI_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function normalizeGeminiQuota(result, fetchedAt = Date.now()) {
  const limits = (Array.isArray(result?.buckets) ? result.buckets : []).map(bucket => {
    const remainingPercent = Math.round(Math.min(1, Math.max(0, Number(bucket.remainingFraction))) * 100);
    const remaining = Number(bucket.remainingAmount);
    const total = Number.isFinite(remaining) && bucket.remainingFraction > 0 ? Math.round(remaining / bucket.remainingFraction) : undefined;
    return {
      id: String(bucket.modelId),
      name: String(bucket.modelId),
      usedPercent: 100 - remainingPercent,
      remainingPercent,
      ...(bucket.resetTime && Number.isFinite(Date.parse(bucket.resetTime)) ? { resetsAt: Date.parse(bucket.resetTime) } : {}),
      ...(Number.isFinite(remaining) ? { remainingAmount: remaining } : {}),
      ...(Number.isFinite(total) ? { totalAmount: total, usedAmount: Math.max(0, total - remaining) } : {})
    };
  });
  if (!limits.length) throw new Error("Gemini did not return usable quota buckets.");
  return { provider: "gemini", fetchedAt, primaryLimitId: limits[0].id, limits };
}

function readGeminiUsage({ session, signal, timeoutMs = 10_000, now = () => Date.now(), spawn = defaultSpawn, helperFile = path.join(__dirname, "gemini-usage-helper.cjs") }) {
  return new Promise((resolve, reject) => {
    const helperSource = session.type === "wsl" ? fs.readFileSync(helperFile, "utf8") : null;
    const command = session.type === "wsl" ? "wsl.exe" : "node.exe";
    const args = session.type === "wsl"
      ? ["-d", session.wslDistro, "--", "node", "-e", `eval(Buffer.from('${Buffer.from(helperSource).toString("base64")}','base64').toString())`]
      : [helperFile];
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); try { child.kill(); } catch {} if (error) reject(error); else resolve(value); };
    const onAbort = () => finish(new Error("Gemini quota request was canceled."));
    const timer = setTimeout(() => finish(new Error("Reading Gemini quota timed out.")), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) finish(new Error("Gemini quota response exceeded the allowed size.")); });
    child.stderr.on("data", chunk => { if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8"); });
    child.once("error", finish);
    child.once("close", () => {
      let result;
      try { result = JSON.parse(stdout); } catch { finish(new Error("Gemini quota helper returned invalid output.")); return; }
      if (!result.ok) finish(new Error(result.error || "Gemini quota is unavailable."));
      else finish(undefined, normalizeGeminiQuota(result, now()));
    });
  });
}

module.exports = { GEMINI_CACHE_TTL_MS, normalizeGeminiQuota, readGeminiUsage };
