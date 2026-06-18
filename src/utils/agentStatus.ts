import type { TranslationKey, TranslationParams } from "../i18n";
import type { AgentStatusPayload } from "../vite-env";

type Translate = (key: TranslationKey, params?: TranslationParams) => string;

function getAgentName(status: AgentStatusPayload) {
  if (status.provider === "codex") return "Codex";
  if (status.provider === "opencode") return "OpenCode";
  if (status.provider === "qoder") return "Qoder";
  return "Claude";
}

export function getAgentStatusLabel(status: AgentStatusPayload | undefined, t: Translate) {
  if (!status) return "";
  const agent = getAgentName(status);

  if (status.status === "waiting_for_permission") {
    return status.toolName
      ? t("agent.waitingForPermissionTool", { agent, tool: status.toolName })
      : t("agent.waitingForPermission", { agent });
  }
  if (status.status === "e_prompt") return t("agent.idlePrompt", { agent });
  if (status.status === "completed") return t("agent.completed", { agent });
  if (status.status === "failed") return t("agent.failed", { agent });
  if (status.status === "running") return t("agent.running", { agent });
  if (status.status === "ended") return t("agent.ended", { agent });
  if (status.status === "exited") return t("agent.exited");
  return "";
}

export function getAgentStatusClass(status?: AgentStatusPayload) {
  return status?.status ?? "unknown";
}
