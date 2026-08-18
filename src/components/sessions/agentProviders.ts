import type { AgentProvider } from "../../vite-env";

export const AGENT_PROVIDER_OPTIONS: ReadonlyArray<{ value: AgentProvider; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "codebuddy", label: "CodeBuddy" },
  { value: "opencode", label: "OpenCode" },
  { value: "qoder", label: "Qoder" }
];

export function getAgentProviderLabel(provider: AgentProvider) {
  return AGENT_PROVIDER_OPTIONS.find((option) => option.value === provider)?.label || provider;
}
