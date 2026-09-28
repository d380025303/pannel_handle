const EXTERNAL_SOURCES = new Set(["openrouter", "nararouter", "minimax"]);
const AGENTS = new Set(["codex", "opencode", "codebuddy"]);

function normalizeModelSelection(input = {}) {
  const agent = AGENTS.has(input.agentProvider) ? input.agentProvider : undefined;
  if (!agent) return {};
  if (input.type === "ssh") return agent === "codex" ? { codexBackend: "openai" } : {};
  const legacy = agent === "codex" ? input.codexBackend : undefined;
  const requested = agent === "codex" && (legacy === "codebuddy" || input.modelSource === "codebuddy")
    ? "native" : input.modelSource ?? legacy;
  const modelSource = EXTERNAL_SOURCES.has(requested) ? requested : "native";
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

function normalizeRemovedCodexBackend(input) {
  if (input.agentProvider !== "codex" || (input.codexBackend !== "codebuddy" && input.modelSource !== "codebuddy")) return input;
  return { ...input, modelSource: "native", modelId: undefined, codexBackend: "openai", codexModel: undefined, codexExperimentalAcknowledged: undefined };
}

module.exports = { EXTERNAL_SOURCES, normalizeModelSelection, normalizeRemovedCodexBackend };
