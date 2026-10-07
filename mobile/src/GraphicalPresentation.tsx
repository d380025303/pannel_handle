import type { AgentProvider, GraphicalItem, GraphicalSnapshot } from "./types";
import { useState } from "react";
import { AcpToolContent } from "../../src/components/shared/AcpToolContent";

export const graphicalProviders: AgentProvider[] = ["codex", "codebuddy", "opencode", "claude", "qoder", "gemini", "grok"];
export const permissions = [
  { value: "readOnly", name: "只读", description: "可检查文件，不能修改或申请扩权" },
  { value: "askApproval", name: "需要确认", description: "可修改工作区，越界操作先确认" },
  { value: "fullAccess", name: "完全访问", description: "可访问文件与网络，不再请求批准" }
] as const;

export function openCodePlanReplyId(snapshot: GraphicalSnapshot) {
  if (snapshot.provider !== "opencode" || snapshot.nativeMode !== "plan" || snapshot.busy || snapshot.archived
    || snapshot.error || snapshot.pendingPlan || !snapshot.threadId
    || !snapshot.nativeModes?.some(mode => mode.id.toLowerCase() === "build")) return null;
  const lastUserIndex = snapshot.items.map(item => item.type).lastIndexOf("userMessage");
  if (lastUserIndex < 0) return null;
  const reply = snapshot.items.slice(lastUserIndex + 1);
  if (reply.some(item => item.type === "turnError")) return null;
  return reply.filter(item => item.type === "agentMessage" && Boolean(item.text?.trim())
    || item.type === "turnPlan" && Boolean(item.plan?.length)).at(-1)?.id || null;
}

export function providerLabel(provider?: string) {
  return provider === "codebuddy" ? "CodeBuddy" : provider === "opencode" ? "OpenCode" : provider === "claude" ? "Claude" : provider === "qoder" ? "Qoder" : provider === "gemini" ? "Gemini" : provider === "grok" ? "Grok" : "Codex";
}

const execModeIds = ["default", "normal", "code", "ask", "build", "acceptEdits"];
export function canSwitchMode(snapshot: GraphicalSnapshot, mode: "default" | "plan") {
  if (snapshot.provider === "codex") return mode === "default" || snapshot.capabilities?.plan !== false;
  const modes = snapshot.nativeModes || [];
  if (snapshot.provider === "codebuddy" && mode === "default")
    return modes.some(value => value.id === "bypassPermissions" || value.id === "fullAccess");
  return mode === "plan" ? modes.some(value => /plan/i.test(value.id))
    : modes.some(value => execModeIds.some(id => id.toLowerCase() === value.id.toLowerCase()));
}
function configLabel(snapshot: GraphicalSnapshot, id: "model" | "effort") {
  const option = snapshot.acpOptions?.find(value => value.id === (id === "effort" && snapshot.provider === "qoder" ? "reasoning_effort" : id));
  const value = typeof option?.currentValue === "string" ? option.currentValue : null;
  return value ? option?.options.find(entry => entry.value === value)?.name || value : null;
}
export function modelLabel(snapshot: GraphicalSnapshot) {
  if (snapshot.provider === "codebuddy" && snapshot.modelSource && snapshot.modelSource !== "native") return `${snapshot.modelSource} · ${snapshot.serviceModelId || "服务模型"}`;
  const model = configLabel(snapshot, "model");
  if (model) return model;
  const id = snapshot.model || snapshot.effectiveModel;
  return id ? snapshot.models?.find(value => value.id === id)?.displayName || id : "未提供";
}
export function modelOptions(snapshot: GraphicalSnapshot) {
  if (snapshot.provider === "codex") return snapshot.backend === "openai"
    ? (snapshot.models || []).map(model => ({ value: model.id, name: model.displayName })) : [];
  return snapshot.acpOptions?.find(option => option.id === "model")?.options || [];
}
export function openCodeEffortOption(snapshot: GraphicalSnapshot) {
  if (snapshot.provider === "codex" && snapshot.backend === "openai") {
    const model = snapshot.models?.find(value => value.id === (snapshot.model || snapshot.effectiveModel));
    if (model?.supportedReasoningEfforts?.length) return { id: "effort", type: "select", currentValue: snapshot.effort || model.defaultReasoningEffort || undefined,
      options: model.supportedReasoningEfforts.map(value => ({ value: value.reasoningEffort, name: value.reasoningEffort, description: value.description })) };
  }
  return snapshot.provider === "opencode"
    ? snapshot.acpOptions?.find(option => option.id === "effort" && option.type === "select" && option.options.length > 0)
    : undefined;
}
export function effortLabel(snapshot: GraphicalSnapshot) {
  const effort = configLabel(snapshot, "effort") || snapshot.effort;
  const labels: Record<string, string> = { low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高" };
  return effort ? labels[effort] || effort : "未提供";
}
export function permissionLabel(permission?: string | null) {
  const labels: Record<string, string> = { readOnly: "只读", askApproval: "需要确认", fullAccess: "完全访问" };
  return permission ? labels[permission] || permission : null;
}

type TimelineEntry = { kind: "item"; item: GraphicalItem } | { kind: "tools"; items: GraphicalItem[] };
const toolTypes = new Set(["commandExecution", "fileChange", "toolCall", "mcpToolCall", "dynamicToolCall", "webSearch"]);
const visibleTypes = new Set(["userMessage", "agentMessage", "plan", "turnPlan", "questionAnswer", "backgroundTurn", "turnError", "reasoning", "collabAgentToolCall", "contextCompaction", "enteredReviewMode", "exitedReviewMode"]);
export function codexReasoningSummary(item: GraphicalItem) {
  return item.summary?.map(part => typeof part === "string" ? part : part.text || "").filter(Boolean).join("\n\n").trim() || "";
}
export function groupTimeline(items: GraphicalItem[], provider?: AgentProvider): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const item of items) {
    if (!toolTypes.has(item.type) && !visibleTypes.has(item.type)) continue;
    if (provider === "codex" && item.type === "reasoning" && !codexReasoningSummary(item)) continue;
    const previous = entries.at(-1);
    if (toolTypes.has(item.type)) {
      if (previous?.kind === "tools" && (!previous.items[0].turnId || !item.turnId || previous.items[0].turnId === item.turnId))
        previous.items.push(item);
      else entries.push({ kind: "tools", items: [item] });
    } else entries.push({ kind: "item", item });
  }
  return entries;
}
export function toolStatus(items: GraphicalItem[]) {
  if (items.some(item => item.status === "failed" || item.status === "declined")) return "有失败";
  if (items.every(item => item.status === "completed")) return "已完成";
  return "进行中";
}
function itemStatus(status?: string) {
  return status === "completed" ? "已完成" : status === "failed" ? "失败" : status === "declined" ? "已拒绝"
    : status === "inProgress" ? "进行中" : status === "pending" ? "等待中" : status || "进行中";
}
function toolLabel(item: GraphicalItem) {
  if (item.toolName || item.tool) return item.toolName || item.tool;
  if (item.type === "fileChange") return "文件变更";
  if (item.type === "webSearch") return "搜索";
  if (item.type === "commandExecution" || item.toolKind === "execute") return "执行命令";
  return "工具调用";
}
function toolSummary(item: GraphicalItem) {
  const change = Array.isArray(item.changes) ? item.changes[0] : null;
  const changedFile = change && typeof change === "object" ? String((change as Record<string, unknown>).path || (change as Record<string, unknown>).filePath || "") : "";
  return item.command?.trim().split(/\r?\n/, 1)[0] || item.query || item.locations?.[0]?.path || changedFile || item.server || "";
}
function codeBuddyToolPresentation(item: GraphicalItem) {
  const labels: Record<string, string> = {
    read: "读取文件", write: "写入文件", edit: "编辑文件", delete: "删除文件", move: "移动文件",
    search: "搜索", fetch: "网页读取", execute: "执行命令"
  };
  const label = labels[item.toolKind || ""] || toolLabel({ ...item, toolName: undefined, tool: undefined });
  if (!item.toolName && item.command) return { label, summary: item.command.trim().split(/\r?\n/, 1)[0] };
  const output = item.output?.trim() || "";
  if (output && output.length <= 80 && !/[\r\n]/.test(output)) return { label, summary: output };
  const titlePath = item.toolName?.replace(/\s+\(\d+\s*-\s*\d+\)$/, "").match(/^(?:Read|Edit|Write|Delete|Move)\s+(.+)$/i)?.[1];
  const target = item.locations?.[0]?.path || item.locations?.[0]?.uri || titlePath || "";
  return { label, summary: target.split(/[\\/]/).pop() || "" };
}
export function ToolItem({ item, codeBuddy = false }: { item: GraphicalItem; codeBuddy?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const presentation = codeBuddy ? codeBuddyToolPresentation(item) : null;
  return <details className="graphical-tool" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><span className="graphical-tool-label">{presentation?.label || toolLabel(item)}</span><span className="graphical-tool-summary">{presentation?.summary ?? toolSummary(item)}</span>
      <span className="graphical-tool-status">{itemStatus(item.status)}</span></summary>
    {(!item.toolContent || expanded) && <div className="graphical-tool-details">
      {codeBuddy && item.toolName && <pre>{item.toolName}</pre>}
      {item.command && <pre>{item.command}</pre>}{item.server && <p>{item.server}</p>}{item.query && <p>{item.query}</p>}
      {item.arguments != null && <pre>{typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments, null, 2)}</pre>}
      {item.text && <p>{item.text}</p>}{item.toolContent ? <AcpToolContent content={item.toolContent} /> : item.output && <pre>{item.output}</pre>}
      {item.result != null && <pre>{typeof item.result === "string" ? item.result : JSON.stringify(item.result, null, 2)}</pre>}
      {item.changes != null && <pre>{JSON.stringify(item.changes, null, 2)}</pre>}
      {item.locations?.map((location, index) => <p key={index}>{location.path || location.uri || "相关位置"}{location.line != null ? `:${location.line}` : ""}</p>)}
      {!item.command && !item.server && !item.query && item.arguments == null && !item.text && !item.output && !(codeBuddy && item.toolName)
        && item.result == null && item.changes == null && !item.locations?.length && !item.toolContent?.length && <p>等待工具返回内容…</p>}
    </div>}
  </details>;
}

