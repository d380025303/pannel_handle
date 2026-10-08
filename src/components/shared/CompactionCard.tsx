import { MarkdownBlock } from "./MarkdownBlock";
import { AcpToolContent } from "./AcpToolContent";

type Compaction = { status?: string; compactionSummary?: unknown[]; compactionError?: string; compactionSource?: string };
const labels: Record<string, string> = { in_progress: "正在压缩上下文…", completed: "上下文压缩完成", failed: "上下文压缩失败", cancelled: "上下文压缩已取消", unknown: "压缩状态未确认" };

export function CompactionCard({ item, className }: { item: Compaction; className: string }) {
  const blocks: unknown[] = [];
  for (const block of item.compactionSummary || []) {
    const value = block && typeof block === "object" ? block as Record<string, unknown> : {};
    const previous = blocks.at(-1) as Record<string, unknown> | undefined;
    if (value.type === "text" && typeof value.text === "string" && previous?.type === "text")
      blocks[blocks.length - 1] = { ...previous, text: String(previous.text || "") + value.text };
    else blocks.push(block);
  }
  return <article className={className}>
    <div role="status">{item.status === "in_progress" && <span className="codex-app-server-tool-spinner" aria-hidden="true" />}{labels[item.status || ""] || "压缩状态未确认"}{item.compactionSource && ` · 子会话：${item.compactionSource}`}</div>
    {item.compactionError && <p role="alert">{item.compactionError}</p>}
    {blocks.length > 0 && <details><summary>查看压缩摘要</summary>{blocks.map((block, index) => {
      const value = block && typeof block === "object" ? block as Record<string, unknown> : {};
      return value.type === "text" && typeof value.text === "string"
        ? <MarkdownBlock key={index} content={value.text} /> : <AcpToolContent key={index} content={[block]} />;
    })}</details>}
  </article>;
}
