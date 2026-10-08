import type { GraphicalSnapshot } from "./types";

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
