function getProviderName(provider) {
  if (provider === "codex") return "Codex";
  if (provider === "codebuddy") return "CodeBuddy";
  if (provider === "opencode") return "OpenCode";
  if (provider === "qoder") return "Qoder";
  if (provider === "copilot") return "GitHub Copilot";
  if (provider === "gemini") return "Gemini CLI";
  if (provider === "grok") return "Grok CLI";
  return "Claude";
}

module.exports = { getProviderName };
