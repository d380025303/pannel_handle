import type { AgentProvider } from "../../vite-env";

export const AGENT_PROVIDER_OPTIONS: ReadonlyArray<{ value: AgentProvider; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "codebuddy", label: "CodeBuddy" },
  { value: "opencode", label: "OpenCode" },
  { value: "qoder", label: "Qoder" },
  { value: "copilot", label: "GitHub Copilot" },
  { value: "gemini", label: "Gemini CLI" },
  { value: "grok", label: "Grok CLI" }
];

export const LOCAL_BRIDGE_AGENT_PROVIDERS = new Set<AgentProvider>(["codex", "codebuddy", "opencode", "claude", "qoder"]);

export function supportsLocalBridge(provider?: AgentProvider): boolean {
  return Boolean(provider && LOCAL_BRIDGE_AGENT_PROVIDERS.has(provider));
}

export function getAgentProviderLabel(provider: AgentProvider) {
  return AGENT_PROVIDER_OPTIONS.find((option) => option.value === provider)?.label || provider;
}
