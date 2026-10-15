import type { GraphicalSnapshot } from "./types";

export function graphicalPermissionSwitchError(snapshot: GraphicalSnapshot): string | null {
  if (snapshot.provider !== "codex") return "当前 Agent 不支持切换执行权限。";
  if (!snapshot.threadId) return "会话未就绪。";
  if (snapshot.busy) return "会话正在执行，请结束后切换权限。";
  if (snapshot.changingPermission) return "执行权限正在切换。";
  if (snapshot.archived) return "已归档的会话不可切换权限。";
  if (snapshot.pendingPlan) return "请先处理待确认计划，再切换权限。";
  if (snapshot.approvals.length || snapshot.questions.length || snapshot.elicitations?.length) return "请先处理待确认操作，再切换权限。";
  if (snapshot.compacting || snapshot.reviewing || snapshot.sandboxSettingUp) return "会话正在处理其他操作，请完成后切换权限。";
  if (snapshot.signedOut) return "请先登录 Codex 账号。";
  return null;
}

export function graphicalInputPolicy(snapshot: GraphicalSnapshot, historyMutation = false) {
  const canSendWhileBusy = snapshot.provider === "codex" && !snapshot.compacting && !snapshot.reviewing;
  const canInput = !(snapshot.provider === "opencode" && ["running", "reconnecting"].includes(snapshot.acpAuth?.status || "")) && Boolean(snapshot.threadId) && !snapshot.signedOut && !snapshot.archived && !historyMutation
    && (!snapshot.busy || canSendWhileBusy);
  const canSubmit = canInput && !snapshot.permissionError && !snapshot.changingPermission && !snapshot.compacting && !snapshot.reviewing && !snapshot.sandboxSettingUp && !snapshot.mainAgentChanging;
  return { canInput, canSubmit };
}
export function graphicalPermissionStatus(snapshot: GraphicalSnapshot) {
  if (snapshot.provider === "codex") {
    const labels: Record<string, string> = { readOnly: "只读", askApproval: "需要确认", fullAccess: "完全访问" };
    return `执行权限：${labels[snapshot.executionPermission || ""] || "需要确认"}`;
  }
  return snapshot.nativeModes?.length
    ? `模式：${snapshot.nativeModes.find(mode => mode.id === snapshot.nativeMode)?.name || snapshot.nativeMode || "默认"}` : null;
}
