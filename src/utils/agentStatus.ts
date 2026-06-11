import type { AgentStatusPayload } from "../vite-env";

function getAgentName(status: AgentStatusPayload) {
  if (status.provider === "codex") return "Codex";
  if (status.provider === "opencode") return "OpenCode";
  return "Claude";
}

export function getAgentStatusLabel(status?: AgentStatusPayload) {
  if (!status) return "";
  const agentName = getAgentName(status);

  if (status.status === "waiting_for_permission") {
    return status.toolName ? `${agentName} 等待确认: ${status.toolName}` : `${agentName} 等待确认`;
  }
  if (status.status === "e_prompt") return `${agentName} 空闲中`;
  if (status.status === "completed") return `${agentName} 已完成`;
  if (status.status === "failed") return `${agentName} 失败`;
  if (status.status === "running") return `${agentName} 运行中`;
  if (status.status === "ended") return `${agentName} 已结束`;
  if (status.status === "exited") return "进程已退出";
  return "";
}

export function getAgentStatusClass(status?: AgentStatusPayload) {
  return status?.status ?? "unknown";
}
