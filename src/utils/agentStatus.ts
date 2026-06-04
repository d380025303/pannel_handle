import type { AgentStatusPayload } from "../vite-env";

export function getAgentStatusLabel(status?: AgentStatusPayload) {
  if (!status) return "";
  if (status.status === "waiting_for_permission") {
    return status.toolName ? `Claude 等待确认: ${status.toolName}` : "Claude 等待确认";
  }
  if (status.status === "completed") return "Claude 已完成";
  if (status.status === "failed") return "Claude 失败";
  if (status.status === "running") return "运行中";
  if (status.status === "ended") return "Claude 已结束";
  if (status.status === "exited") return "进程已退出";
  return "";
}

export function getAgentStatusClass(status?: AgentStatusPayload) {
  return status?.status ?? "unknown";
}
