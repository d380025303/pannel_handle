import { useId, useState } from "react";
import { ChevronRight, CircleCheck, CircleX, Code2, FileDiff, FileSearch, FileText, Globe2, Search, Terminal, Wrench } from "lucide-react";
import type { CodexAppServerSnapshot } from "../../vite-env";
import { MarkdownBlock } from "../shared/MarkdownBlock";
import { AcpToolContent } from "../shared/AcpToolContent";

const statusLabels: Record<string, string> = { completed: "已完成", inProgress: "进行中", in_progress: "进行中", pending: "待处理", failed: "失败", declined: "已拒绝" };
export const statusLabel = (status?: string) => statusLabels[status || ""] || status || "进行中";
type SessionItem = CodexAppServerSnapshot["items"][number];
type TeamMember = NonNullable<CodexAppServerSnapshot["team"]>["members"][number];
type ToolDisplayItem = { kind: "item"; item: SessionItem } | { kind: "tools"; items: SessionItem[] };
type DisplayItem = ToolDisplayItem
  | { kind: "diagnostic"; event: Diagnostic }
  | { kind: "diff"; diff: NonNullable<CodexAppServerSnapshot["turnDiffs"]>[number] };
const toolTypes = new Set(["commandExecution", "fileChange", "toolCall", "mcpToolCall", "dynamicToolCall", "webSearch"]);
const isTool = (item: SessionItem) => toolTypes.has(item.type);
function reasoningSummary(item: SessionItem) {
  return item.summary?.map(part => typeof part === "string" ? part : part.text || "").filter(Boolean).join("\n\n").trim() || "";
}
function groupTools(items: SessionItem[], showCodexEvents = false, minimalMode = false): ToolDisplayItem[] {
  const result: ToolDisplayItem[] = [];
  const isHidden = (item: SessionItem) => !showCodexEvents && !isTool(item)
    && !["userMessage", "agentMessage", "plan", "turnPlan", "questionAnswer", "backgroundTurn", "turnError"].includes(item.type);
  const sameTurn = (first: SessionItem, second: SessionItem) => !first.turnId || !second.turnId || first.turnId === second.turnId;
  for (const item of items) {
    if (isHidden(item) || item.type === "reasoning" && (minimalMode || !reasoningSummary(item))) continue;
    const previous = result.at(-1);
    if (isTool(item)) {
      if (previous?.kind === "tools" && sameTurn(previous.items[0], item)) previous.items.push(item);
      else result.push({ kind: "tools", items: [item] });
    } else result.push({ kind: "item", item });
  }
  return result;
}

function toolPresentation(item: SessionItem) {
  const kind = item.type === "fileChange" || ["read", "edit", "delete", "move"].includes(item.toolKind || "") ? "file"
    : item.type === "webSearch" || item.toolKind === "search" ? "search"
      : item.toolKind === "fetch" ? "web" : item.type === "commandExecution" || item.toolKind === "execute" ? "command" : "other";
  const Icon = kind === "file" ? FileDiff : kind === "search" ? Search : kind === "web" ? Globe2 : kind === "command" ? Terminal : Wrench;
  const label = kind === "file" ? "文件变更" : kind === "search" ? "搜索" : kind === "web" ? "网页读取" : kind === "command" ? "执行命令" : "工具调用";
  return { kind, Icon, label };
}

function codeBuddyToolPresentation(item: SessionItem) {
  const labels: Record<string, string> = {
    read: "读取文件", write: "写入文件", edit: "编辑文件", delete: "删除文件", move: "移动文件",
    search: "搜索", fetch: "网页读取", execute: "执行命令"
  };
  const label = labels[item.toolKind || ""] || toolPresentation(item).label;
  if (!item.toolName && item.command) return { label, summary: item.command.trim().split(/\r?\n/, 1)[0] };
  const output = item.output?.trim() || "";
  if (output && output.length <= 80 && !/[\r\n]/.test(output)) return { label, summary: output };
  const titlePath = item.toolName?.replace(/\s+\(\d+\s*-\s*\d+\)$/, "").match(/^(?:Read|Edit|Write|Delete|Move)\s+(.+)$/i)?.[1];
  const target = item.locations?.[0]?.path || item.locations?.[0]?.uri || titlePath || "";
  return { label, summary: target.split(/[\\/]/).pop() || "" };
}

function toolDetails(item: SessionItem) {
  if (item.type === "fileChange" && Array.isArray(item.changes)) return <><div className="codex-app-server-tool-files">{item.changes.map((change, index) => {
    const value = change && typeof change === "object" ? change as Record<string, unknown> : {};
    return <div key={`${String(value.path || "file")}-${index}`}><FileText aria-hidden="true" /><span>{String(value.path || value.filePath || "未知文件")}</span><small>{String(value.kind || value.type || "变更")}</small></div>;
  })}</div><details className="codex-app-server-tool-raw"><summary>原始变更</summary><pre>{JSON.stringify(item.changes, null, 2)}</pre></details></>;
  if (item.locations?.length) return <div className="codex-app-server-tool-files">{item.locations.map((location, index) => <div key={index}><FileSearch aria-hidden="true" /><span>{location.path || location.uri || "相关位置"}{location.line != null ? `:${location.line}` : ""}</span></div>)}</div>;
  return null;
}

function ToolCard({ item, codeBuddy = false }: { item: SessionItem; codeBuddy?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const { kind, Icon, label } = toolPresentation(item);
  const firstChange = Array.isArray(item.changes) ? item.changes[0] : null;
  const changedFile = firstChange && typeof firstChange === "object" ? String((firstChange as Record<string, unknown>).path || (firstChange as Record<string, unknown>).filePath || "") : "";
  const presentation = codeBuddy ? codeBuddyToolPresentation(item) : null;
  const summary = presentation?.summary ?? (item.command?.trim().split(/\r?\n/, 1)[0] || item.query || item.locations?.[0]?.path || changedFile || item.server || "");
  return <div className="codex-app-server-tool">
    <button type="button" className="codex-app-server-tool-heading" data-kind={kind} data-status={item.status}
      aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined} onClick={() => setExpanded(current => !current)}>
      <ChevronRight className="codex-app-server-tool-chevron" aria-hidden="true" /><Icon aria-hidden="true" />
      <strong>{presentation?.label || item.toolName || item.tool || label}</strong>{summary && <span className="codex-app-server-tool-summary" title={summary}>{summary}</span>}
      <span className="codex-app-server-tool-status">{item.status === "completed" ? <CircleCheck aria-hidden="true" /> : item.status === "failed" || item.status === "declined" ? <CircleX aria-hidden="true" /> : <span className="codex-app-server-tool-spinner" aria-hidden="true" />}{statusLabel(item.status)}</span>
    </button>
    {expanded && <div id={detailsId} className="codex-app-server-tool-details">
      {codeBuddy && item.toolName && <pre className="codex-app-server-tool-command">{item.toolName}</pre>}
      {item.command && <pre className="codex-app-server-tool-command">{item.command}</pre>}
      {item.server && <p className="codex-app-server-tool-query">{item.server}</p>}
      {item.query && <p className="codex-app-server-tool-query">{item.query}</p>}
      {item.arguments != null && <pre className="codex-app-server-tool-command">{typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments, null, 2)}</pre>}
      {toolDetails(item)}
      {item.toolContent ? <AcpToolContent content={item.toolContent} /> : item.output && <pre className="codex-app-server-tool-output">{item.output}</pre>}
      {item.result != null && <pre className="codex-app-server-tool-output">{typeof item.result === "string" ? item.result : JSON.stringify(item.result, null, 2)}</pre>}
      {item.changes != null && !Array.isArray(item.changes) && <pre>{JSON.stringify(item.changes, null, 2)}</pre>}
      {!item.command && !item.output && !item.query && item.arguments == null && !item.locations?.length && !item.toolContent?.length && item.changes == null && item.result == null && !(codeBuddy && item.toolName) && <p className="codex-app-server-tool-placeholder">等待工具返回内容…</p>}
    </div>}
  </div>;
}

export function ToolGroup({ items, expanded, onToggle, codeBuddy = false }: { items: SessionItem[]; expanded: boolean; onToggle: () => void; codeBuddy?: boolean }) {
  const status = toolGroupStatus(items);
  return <section className="codex-app-server-event" data-status={status}>
    <button type="button" className="codex-app-server-event-summary" aria-expanded={expanded} onClick={onToggle}>
      <ChevronRight className="codex-app-server-event-chevron" aria-hidden="true" />
      <span className="codex-app-server-event-glyph"><Code2 aria-hidden="true" /></span>
      <strong>工具调用 · {items.length} 项</strong><span className="codex-app-server-event-status">{status}</span>
    </button>
    {expanded && items.map(item => <ToolCard item={item} codeBuddy={codeBuddy} key={item.id} />)}
  </section>;
}

const standardItemTypes = new Set(["userMessage", "agentMessage", "plan", "turnPlan", "questionAnswer", "contextCompaction"]);
export function CodexEventCard({ item }: { item: SessionItem }) {
  if (item.type === "reasoning") {
    const summary = reasoningSummary(item);
    if (!summary) return null;
    return <article className="codex-app-server-message codexEvent" key={item.id}>
      <strong>推理摘要</strong><MarkdownBlock className="codex-app-server-markdown" content={summary} />
    </article>;
  }
  if (item.type === "collabToolCall" || item.type === "collabAgentToolCall") return <article className="codex-app-server-message codexEvent" key={item.id}>
    <strong>协作调用 · {item.tool || "协作工具"}</strong>
    <p>{statusLabel(item.status)}{item.agentStatus ? ` · 成员${item.agentStatus}` : ""}</p>
    {item.senderThreadId && <p>发起线程：{item.senderThreadId}</p>}
    {item.receiverThreadId && <p>目标线程：{item.receiverThreadId}</p>}
    {item.newThreadId && <p>新线程：{item.newThreadId}</p>}
    {item.prompt && <details><summary>查看任务内容</summary><p>{item.prompt}</p></details>}
  </article>;
  if (item.type === "imageView") return <article className="codex-app-server-message codexEvent" key={item.id}>
    <strong>查看图片</strong><p>{item.path || "未提供图片路径"}</p>
  </article>;
  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") return <article className="codex-app-server-message codexEvent" key={item.id}>
    <strong>{item.type === "enteredReviewMode" ? "开始代码审查" : "代码审查完成"}</strong>
    {item.review && <MarkdownBlock className="codex-app-server-markdown" content={item.review} />}
  </article>;
  if (standardItemTypes.has(item.type)) return null;
  return <article className="codex-app-server-message codexEvent" key={item.id}>
    <strong>Codex 事件</strong><p>未识别的事件类型：{item.type}</p>
  </article>;
}

export const teamStatusLabels: Record<string, string> = {
  running: "运行中", idle: "空闲", paused: "已暂停", completed: "已完成", failed: "失败",
  cancelled: "已取消", killed: "已终止", unresumable: "无法恢复", removed: "已离队", unknown: "状态未知"
};

export function TeamMemberTimeline({ member, onLinkClick, codeBuddy = true, minimalMode = false }: { member: TeamMember; onLinkClick?: (href: string) => void; codeBuddy?: boolean; minimalMode?: boolean }) {
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  return <div className="codex-app-server-team-timeline" aria-label={`${member.name} 的消息时间线`}>
    {!member.items.length && <p className="codex-app-server-team-empty">暂无成员消息。</p>}
    {groupTools(member.items, !codeBuddy, minimalMode).map(entry => {
      if (entry.kind === "tools") {
        const groupId = entry.items[0].id;
        return <ToolGroup key={groupId} items={entry.items} codeBuddy={codeBuddy} expanded={expandedGroupId === groupId}
          onToggle={() => setExpandedGroupId(current => current === groupId ? null : groupId)} />;
      }
      const item = entry.item;
      if (item.type === "userMessage" || item.type === "agentMessage") return <article className={`codex-app-server-message ${item.type}`} key={item.id}>
        {item.type === "userMessage" ? <p>{item.text}</p>
          : item.text && <MarkdownBlock className="codex-app-server-markdown" content={item.text} externalLinks={!onLinkClick} onLinkClick={onLinkClick} linkActions />}
      </article>;
      if (item.type === "turnPlan") return <article className="codex-app-server-message turnPlan" key={item.id}>
        <strong>计划进度</strong><ol>{item.plan?.map((step, index) => <li key={index}>{step.step} <span>{statusLabel(step.status)}</span></li>)}</ol>
      </article>;
      return codeBuddy ? null : <CodexEventCard key={item.id} item={item} />;
    })}
  </div>;
}

function toolGroupStatus(items: SessionItem[]) {
  if (items.some(item => item.status === "failed" || item.status === "declined")) return "有失败";
  if (items.every(item => item.status === "completed")) return "已完成";
  return "进行中";
}

type Diagnostic = NonNullable<CodexAppServerSnapshot["diagnostics"]>[number];
const diagnosticNames: Record<string, string> = {
  configWarning: "配置警告", warning: "运行警告",
  "model/rerouted": "模型重路由", "model/safetyBuffering/updated": "模型安全缓冲",
  "model/verification": "模型验证", error: "运行错误"
};
const errorNames: Record<string, string> = {
  ContextWindowExceeded: "上下文窗口已满", UsageLimitExceeded: "用量限制", HttpConnectionFailed: "上游连接失败",
  ResponseStreamConnectionFailed: "响应流连接失败", ResponseStreamDisconnected: "响应流中断",
  ResponseTooManyFailedAttempts: "重试次数过多", BadRequest: "请求无效", Unauthorized: "身份验证失败",
  SandboxError: "沙箱错误", InternalServerError: "服务内部错误", Other: "其他错误"
};
function diagnosticSummary(event: Diagnostic) {
  const data = event.payload;
  if (event.kind === "configWarning") return String(data.summary || "配置需要检查");
  if (event.kind === "warning" || event.kind === "error") return String(data.message || "运行遇到问题");
  if (event.kind === "model/rerouted") return `${String(data.fromModel || "原模型")} → ${String(data.toModel || "目标模型")}`;
  if (event.kind === "model/verification") return "需要额外账户验证";
  return event.kind === "model/safetyBuffering/updated" ? "响应正在安全缓冲" : "查看详情";
}
export function DiagnosticCard({ event }: { event: Diagnostic }) {
  const data = event.payload;
  const kind = event.kind === "error" || event.kind.includes("Warning") || event.kind === "warning" ? "warning" : "info";
  return <details className="codex-app-server-diagnostic" data-kind={kind}>
    <summary><span>{diagnosticNames[event.kind] || event.kind}</span><strong>{diagnosticSummary(event)}</strong>
      <time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleTimeString()}</time></summary>
    {event.kind === "error" && typeof data.kind === "string" && <p>类别：{errorNames[data.kind] || data.kind}{typeof data.httpStatusCode === "number" ? ` · HTTP ${data.httpStatusCode}` : ""}</p>}
    {event.kind === "configWarning" && typeof data.path === "string" && <p>配置文件：{data.path}</p>}
    {event.kind === "configWarning" && typeof data.details === "string" && <p>{data.details}</p>}
    <pre>{JSON.stringify(data, null, 2)}</pre>
  </details>;
}
export function groupTimeline(snapshot: CodexAppServerSnapshot, minimalMode = false): DisplayItem[] {
  const groups = groupTools(snapshot.items, !snapshot.provider || snapshot.provider === "codex", minimalMode);
  const events = (snapshot.diagnostics || []).filter(event => !event.kind.startsWith("hook/"));
  const diffs = snapshot.turnDiffs || [];
  const eventsByTurn = new Map<string, Diagnostic[]>();
  const unassignedEvents: Diagnostic[] = [];
  for (const event of events) {
    if (!event.turnId) { unassignedEvents.push(event); continue; }
    const turnEvents = eventsByTurn.get(event.turnId) || [];
    turnEvents.push(event);
    eventsByTurn.set(event.turnId, turnEvents);
  }
  const diffsByTurn = new Map(diffs.map(diff => [diff.turnId, diff]));
  const lastIndex = new Map<string, number>();
  groups.forEach((group, index) => {
    const turnId = group.kind === "tools" ? group.items.at(-1)?.turnId : group.item.turnId;
    if (turnId) lastIndex.set(turnId, index);
  });
  const result: DisplayItem[] = unassignedEvents.map(event => ({ kind: "diagnostic", event }));
  groups.forEach((group, index) => {
    result.push(group);
    const turnId = group.kind === "tools" ? group.items.at(-1)?.turnId : group.item.turnId;
    if (!turnId || lastIndex.get(turnId) !== index) return;
    result.push(...(eventsByTurn.get(turnId) || []).map(event => ({ kind: "diagnostic" as const, event })));
    const diff = diffsByTurn.get(turnId);
    if (diff) result.push({ kind: "diff", diff });
  });
  const seenTurns = new Set(lastIndex.keys());
  result.push(...events.filter(event => event.turnId && !seenTurns.has(event.turnId)).map(event => ({ kind: "diagnostic", event } as DisplayItem)));
  result.push(...diffs.filter(diff => !seenTurns.has(diff.turnId)).map(diff => ({ kind: "diff", diff } as DisplayItem)));
  return result;
}
