const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn: defaultSpawn, spawnSync: defaultSpawnSync } = require("node:child_process");

const MAX_TRANSLATION_INPUT_BYTES = 512 * 1024;
const MAX_TRANSLATION_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120 * 1000;
const TRANSLATION_SCHEMA = {
  type: "object",
  properties: { translatedContent: { type: "string" } },
  required: ["translatedContent"],
  additionalProperties: false
};

function sourceHash(content) {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

function translationPrompt(content) {
  return [
    "Translate the following SKILL.md into Simplified Chinese.",
    "Return the complete document in translatedContent.",
    "Preserve Markdown and YAML structure, front matter keys, code blocks, commands, paths, variables, identifiers, URLs, and product names exactly.",
    "Translate natural-language prose and human-readable YAML values such as description. Do not add explanations or Markdown fences around the result.",
    "",
    "<skill_document>",
    content,
    "</skill_document>"
  ].join("\n");
}

function buildInvocation(provider, temporaryDirectory) {
  if (provider === "codex") {
    const schemaFile = path.join(temporaryDirectory, "schema.json");
    const outputFile = path.join(temporaryDirectory, "output.json");
    return {
      command: "codex",
      args: ["exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "--output-schema", schemaFile, "--output-last-message", outputFile, "-"],
      schemaFile,
      outputFile
    };
  }
  if (provider === "codebuddy") {
    return {
      command: "codebuddy",
      args: ["--print", "--output-format=json", `--json-schema=${JSON.stringify(TRANSLATION_SCHEMA)}`, "--tools=", "--permission-mode=dontAsk", "--no-session-persistence", "--max-turns=1"]
    };
  }
  throw new Error("Unsupported Skill translation provider.");
}

function findTranslatedContent(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try { return findTranslatedContent(JSON.parse(trimmed)); } catch { return trimmed; }
  }
  if (typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const translated = findTranslatedContent(value[index]);
      if (translated) return translated;
    }
    return "";
  }
  if (typeof value.translatedContent === "string") return value.translatedContent;
  for (const key of ["structured_output", "structuredOutput", "result", "content", "message"]) {
    const translated = findTranslatedContent(value[key]);
    if (translated) return translated;
  }
  return "";
}

function failureReason(error, stderr = "") {
  if (error?.reason) return error.reason;
  const message = `${error?.message || ""}\n${stderr}`;
  if (error?.code === "ENOENT" || /not recognized|not found|cannot find/i.test(message)) return "cli_missing";
  if (/log\s*in|login|authenticat|unauthorized|credential/i.test(message)) return "not_authenticated";
  return "failed";
}

function terminateProcess(child, spawnSync = defaultSpawnSync) {
  if (process.platform === "win32" && Number.isInteger(child?.pid) && child.pid > 0) {
    try {
      spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      return;
    } catch { /* fall through to the direct child */ }
  }
  try { child?.kill(); } catch { /* best effort */ }
}

async function runCli({ provider, prompt, workspaceDirectory, timeoutMs, spawn = defaultSpawn, terminate = terminateProcess, registerCancel = () => {} }) {
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pannel-skill-translation-"));
  const invocation = buildInvocation(provider, temporaryDirectory);
  if (invocation.schemaFile) await fs.promises.writeFile(invocation.schemaFile, JSON.stringify(TRANSLATION_SCHEMA), "utf-8");
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: workspaceDirectory,
        windowsHide: true,
        shell: process.platform === "win32",
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let outputExceeded = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const cancel = () => {
        if (settled) return;
        const error = new Error("Skill translation was canceled.");
        error.reason = "cancelled";
        terminate(child);
        finish(() => reject(error));
      };
      registerCancel(cancel);
      const timer = setTimeout(() => {
        const error = new Error("Skill translation timed out.");
        error.reason = "timeout";
        terminate(child);
        finish(() => reject(error));
      }, timeoutMs);
      child.stdout?.on("data", chunk => {
        stdout += chunk.toString("utf-8");
        if (Buffer.byteLength(stdout, "utf-8") > MAX_TRANSLATION_OUTPUT_BYTES) {
          outputExceeded = true;
          terminate(child);
        }
      });
      child.stderr?.on("data", chunk => {
        stderr += chunk.toString("utf-8");
        if (Buffer.byteLength(stderr, "utf-8") > 64 * 1024) stderr = stderr.slice(-64 * 1024);
      });
      child.once("error", error => finish(() => reject(Object.assign(error, { stderr }))));
      child.once("close", async code => {
        if (settled) return;
        if (outputExceeded) {
          const error = new Error("Skill translation output was too large.");
          error.reason = "invalid_output";
          finish(() => reject(error));
          return;
        }
        if (code !== 0) {
          const error = new Error(stderr.trim() || `Skill translation exited with code ${code}.`);
          error.stderr = stderr;
          finish(() => reject(error));
          return;
        }
        try {
          const raw = invocation.outputFile ? await fs.promises.readFile(invocation.outputFile, "utf-8") : stdout;
          finish(() => resolve(raw));
        } catch (error) {
          finish(() => reject(error));
        }
      });
      child.stdin?.end(prompt, "utf-8");
    });
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function createSkillTranslationService({ workspaceDirectory, timeoutMs = DEFAULT_TIMEOUT_MS, runner = runCli } = {}) {
  if (!workspaceDirectory) throw new Error("A Skill translation workspace is required.");
  const cache = new Map();
  const active = new Map();

  async function translate({ requestId, provider, skillId, content }) {
    const normalizedRequestId = String(requestId || "").trim();
    if (!normalizedRequestId || !skillId || typeof content !== "string") return { status: "error", reason: "invalid_request" };
    if (!new Set(["codex", "codebuddy"]).has(provider)) return { status: "error", reason: "invalid_request" };
    if (Buffer.byteLength(content, "utf-8") > MAX_TRANSLATION_INPUT_BYTES) return { status: "error", reason: "too_large" };
    const hash = sourceHash(content);
    const cacheKey = `${provider}:${skillId}:${hash}`;
    const cached = cache.get(cacheKey);
    if (cached) return { status: "translated", translatedContent: cached, sourceHash: hash, cached: true };

    cancel(normalizedRequestId);
    const controller = { canceled: false, cancelCurrent: () => {} };
    controller.cancel = () => {
      controller.canceled = true;
      controller.cancelCurrent();
    };
    active.set(normalizedRequestId, controller);
    try {
      const raw = await runner({
        provider,
        prompt: translationPrompt(content),
        workspaceDirectory,
        timeoutMs,
        registerCancel: callback => {
          controller.cancelCurrent = callback;
          if (controller.canceled) callback();
        }
      });
      const translatedContent = findTranslatedContent(raw);
      if (!translatedContent || Buffer.byteLength(translatedContent, "utf-8") > MAX_TRANSLATION_OUTPUT_BYTES) {
        return { status: "error", reason: "invalid_output" };
      }
      cache.set(cacheKey, translatedContent);
      return { status: "translated", translatedContent, sourceHash: hash, cached: false };
    } catch (error) {
      return { status: "error", reason: failureReason(error, error?.stderr) };
    } finally {
      if (active.get(normalizedRequestId) === controller) active.delete(normalizedRequestId);
    }
  }

  function cancel(requestId) {
    const normalized = String(requestId || "").trim();
    const controller = active.get(normalized);
    if (!controller) return false;
    active.delete(normalized);
    controller.cancel();
    return true;
  }

  function shutdown() {
    for (const controller of active.values()) controller.cancel();
    active.clear();
    cache.clear();
  }

  return { translate, cancel, shutdown };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_TRANSLATION_INPUT_BYTES,
  TRANSLATION_SCHEMA,
  buildInvocation,
  createSkillTranslationService,
  findTranslatedContent,
  sourceHash
};
