const EXTERNAL_SOURCES = new Set(["openrouter", "nararouter", "minimax"]);
const AGENTS = new Set(["codex", "opencode", "codebuddy"]);

function normalizeModelSelection(input = {}) {
  const agent = AGENTS.has(input.agentProvider) ? input.agentProvider : undefined;
  if (!agent) return {};
  if (input.type === "ssh") return agent === "codex" ? { codexBackend: "openai" } : {};
  const legacy = agent === "codex" ? input.codexBackend : undefined;
  const requested = input.modelSource ?? legacy;
  const allowed = agent === "codex" && requested === "codebuddy";
  const modelSource = EXTERNAL_SOURCES.has(requested) || allowed ? requested : "native";
  const modelId = modelSource === "native" ? undefined : String((input.modelId ?? (agent === "codex" ? input.codexModel : "")) || "").trim() || undefined;
  return {
    modelSource,
    modelId,
    ...(agent === "codex" ? {
      codexBackend: modelSource === "native" ? "openai" : modelSource,
      codexModel: modelId,
      codexExperimentalAcknowledged: Boolean(modelId) && input.codexExperimentalAcknowledged === true ? true : undefined
    } : {})
  };
}

module.exports = { EXTERNAL_SOURCES, normalizeModelSelection };
