import { MarkdownBlock } from "./MarkdownBlock";

export const subAgentStatusLabels: Record<string, string> = {
  running: "运行中", pendingInit: "初始化中", idle: "空闲", completed: "已完成",
  waitingOnApproval: "等待审批", waitingOnUserInput: "等待回答", failed: "失败", errored: "失败",
  notLoaded: "未加载", shutdown: "已关闭", interrupted: "已中断", deleted: "已删除",
  notFound: "未找到", unknown: "状态未知", inProgress: "进行中", in_progress: "进行中", pending: "待处理", declined: "已拒绝"
};
type Activity = {
  type: string; kind?: string; agentThreadId?: string; agentPath?: string; tool?: string; status?: string;
  senderThreadId?: string; receiverThreadId?: string; receiverThreadIds?: string[]; newThreadId?: string;
  prompt?: string; agentStatus?: string; agentsStates?: Record<string, { status: string; message?: string | null }>;
};
export const isSubAgentEvent = (item: { type: string }) => ["subAgentActivity", "collabToolCall", "collabAgentToolCall"].includes(item.type);
const activityLabels: Record<string, string> = { started: "开始任务", interacted: "收到交互", interrupted: "任务中断", completed: "任务完成" };
const toolLabels: Record<string, string> = {
  spawnAgent: "启动成员", spawn_agent: "启动成员", sendInput: "发送消息", send_input: "发送消息",
  wait: "等待成员", closeAgent: "关闭成员", close_agent: "关闭成员", resumeAgent: "恢复成员", resume_agent: "恢复成员"
};
export function CodexSubAgentEvent({ item, className }: { item: Activity; className: string }) {
  const activity = item.type === "subAgentActivity";
  const targets = [...new Set([...(item.receiverThreadIds || []), item.receiverThreadId, item.newThreadId,
    item.agentThreadId, ...Object.keys(item.agentsStates || {})].filter((id): id is string => Boolean(id)))];
  return <details className={`${className} codex-sub-agent-event`}>
    <summary><strong>子 Agent · {activity ? activityLabels[item.kind || ""] || item.kind || "活动更新" : toolLabels[item.tool || ""] || item.tool || "协作调用"}</strong>
      {activity && item.agentPath && <span> · {item.agentPath}</span>}
      {!activity && <span> · 调用{subAgentStatusLabels[item.status || ""] || item.status || "进行中"}</span>}
    </summary>
    {item.senderThreadId && <p>发起线程：{item.senderThreadId}</p>}
    {targets.map(id => <div key={id}><p>目标线程：{id}{item.agentsStates?.[id]?.status || item.agentStatus
      ? ` · ${subAgentStatusLabels[item.agentsStates?.[id]?.status || item.agentStatus || ""] || item.agentsStates?.[id]?.status || item.agentStatus}` : ""}</p>
      {item.agentsStates?.[id]?.message && <MarkdownBlock className="codex-app-server-markdown" content={item.agentsStates[id].message!} />}</div>)}
    {item.prompt && <details><summary>查看任务内容</summary><MarkdownBlock className="codex-app-server-markdown" content={item.prompt} /></details>}
  </details>;
}
