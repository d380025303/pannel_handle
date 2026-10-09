type ActivityItem = { type: string; status?: string; durationMs?: number; savedPath?: string | null };
const labels: Record<string, string> = { completed: "已完成", inProgress: "进行中", in_progress: "进行中", pending: "待处理", failed: "失败", cancelled: "已取消", interrupted: "已中断" };

export function CodexActivityEvent({ item, className }: { item: ActivityItem; className: string }) {
  const duration = typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0
    ? `${item.durationMs / 1000} 秒` : null;
  const savedPath = typeof item.savedPath === "string" ? item.savedPath.trim() : "";
  return <article className={className}>
    <strong>{item.type === "sleep" ? "等待" : "图片生成"}</strong>
    <p>{labels[item.status || ""] || item.status || "状态未提供"}</p>
    {item.type === "sleep" && duration && <p>等待时长：{duration}</p>}
    {item.type === "imageGeneration" && savedPath && <p>结果路径：{savedPath}</p>}
  </article>;
}
