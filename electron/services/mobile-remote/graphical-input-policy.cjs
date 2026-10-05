function graphicalSubmitError(snapshot) {
  if (!snapshot.threadId) return "会话尚未就绪。";
  if (snapshot.account?.status === "signedOut") return "请先登录 Codex 账号。";
  if (snapshot.archived) return "已归档的对话不可发送。";
  if (snapshot.windowsSandboxSetup?.status === "running") return "沙箱正在初始化，请稍后发送。";
  if (snapshot.compacting || snapshot.reviewing || snapshot.mainAgent?.changing) return "当前会话正在处理，请稍后发送。";
  if (snapshot.busy && snapshot.provider !== "codex") return "当前 Agent 正在运行，请完成后再发送。";
  return null;
}
module.exports = { graphicalSubmitError };
