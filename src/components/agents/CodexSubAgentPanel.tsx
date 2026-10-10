import { useEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { CodexSubAgents } from "../../vite-env";
import { TeamMemberTimeline } from "./GraphicalTimeline";

import { subAgentStatusLabels as labels } from "../shared/CodexSubAgentEvent";
type Props = { sessionId: string; threadId: string; state: CodexSubAgents; minimalMode?: boolean; onLinkClick?: (href: string) => void };

export function CodexSubAgentPanel({ sessionId, threadId, state, minimalMode = false, onLinkClick }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => { generation.current += 1; setCollapsed(new Set()); setError(""); return () => { generation.current += 1; }; }, [sessionId, threadId]);
  const selected = state.members.find(member => member.threadId === state.selectedThreadId);
  async function act(action: () => Promise<void>) {
    const current = generation.current; setError("");
    try { await action(); } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  const toggleBranch = (id: string) => setCollapsed(previous => {
    const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  function children(parent: string, ancestors: Set<string> = new Set()): React.ReactNode {
    if (ancestors.has(parent)) return null;
    const visited = new Set(ancestors).add(parent);
    return state.members.filter(member => member.parentThreadId === parent).map(member => {
      const hasChildren = state.members.some(child => child.parentThreadId === member.threadId);
      return <li key={member.threadId}>
        <div className="codex-sub-agent-row">
          {hasChildren && <button type="button" className="codex-sub-agent-branch" aria-label={`${collapsed.has(member.threadId) ? "展开" : "折叠"} ${member.name} 的子 Agent`}
            aria-expanded={!collapsed.has(member.threadId)} onClick={() => toggleBranch(member.threadId)}><ChevronRight aria-hidden="true" /></button>}
          <button type="button" aria-pressed={selected?.threadId === member.threadId} onClick={() => void act(() => window.codexAppServerApi.setSubAgentView(sessionId, true, member.threadId, threadId))}>
            <span className="codex-app-server-team-dot" data-status={member.status} /><strong>{member.name}</strong><small>{labels[member.status] || member.status}</small>
          </button>
        </div>
        {hasChildren && !collapsed.has(member.threadId) && <ul>{children(member.threadId, visited)}</ul>}
      </li>;
    });
  }
  return <aside className={`codex-app-server-team-pane codex-sub-agent-pane${state.expanded ? "" : " is-collapsed"}`} aria-label="Codex 子 Agent">
    <div className="codex-app-server-team-heading">
      <button type="button" aria-expanded={state.expanded} onClick={() => void act(() => window.codexAppServerApi.setSubAgentView(sessionId, !state.expanded, undefined, threadId))}>
        <ChevronRight aria-hidden="true" /><strong>子 Agent · {state.members.length}</strong>
      </button>
      {state.expanded && <button type="button" aria-label="刷新子 Agent" disabled={state.loading} onClick={() => void act(() => window.codexAppServerApi.refreshSubAgents(sessionId, threadId))}><RefreshCw aria-hidden="true" /></button>}
    </div>
    {error && <p role="alert" className="codex-sub-agent-notice">{error}</p>}
    {state.expanded && <>
      {state.warning && <p className="codex-sub-agent-notice">{state.warning}</p>}
      {state.error && <p role="alert" className="codex-sub-agent-notice">{state.error}</p>}
      <ul className="codex-sub-agent-tree" aria-label="子 Agent 层级">{children(threadId)}</ul>
      {selected && <>
        <div className="codex-app-server-team-member-detail"><strong>{selected.name}</strong><span>{labels[selected.status] || selected.status}</span>
          {selected.role && <small>{selected.role}</small>}
          {selected.task && <details><summary>任务详情</summary><p>{selected.task}</p></details>}
          <small title={selected.threadId}>线程：{selected.threadId}</small>
        </div>
        {selected.error && <p role="alert" className="codex-sub-agent-notice">{selected.error} <button type="button" disabled={state.loading} onClick={() => void act(() => window.codexAppServerApi.refreshSubAgents(sessionId, threadId))}>重试</button></p>}
        {selected.loading && !selected.items.length && <p role="status" className="codex-sub-agent-notice">正在读取子 Agent 消息…</p>}
        <TeamMemberTimeline key={`${threadId}:${selected.threadId}`} member={selected} messageCopy codeBuddy={false} minimalMode={minimalMode} onLinkClick={onLinkClick} />
      </>}
    </>}
  </aside>;
}
