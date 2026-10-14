import { CloseCompletedAction, type useCloseCompleted } from "./useCloseCompleted";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pencil, X } from "lucide-react";
import { createRequestId } from "./protocol";
import { PROTOCOL_VERSION, type ClientMessage, type RuntimeSession, type SavedTemplate, type SessionOverview } from "./types";

type SessionAction = (type: "rename" | "close", session: RuntimeSession, trigger: HTMLElement) => void;

function kindLabel(type: RuntimeSession["type"]) {
  if (type === "windows") return "Windows";
  if (type === "wsl") return "WSL";
  return "SSH";
}
function modeLabel(session: { runtimeMode: string; agentProvider?: string }) {
  if (session.runtimeMode !== "app-server") return "终端";
  return `${session.agentProvider === "codebuddy" ? "CodeBuddy" : session.agentProvider === "opencode" ? "OpenCode" : session.agentProvider === "claude" ? "Claude" : session.agentProvider === "qoder" ? "Qoder" : session.agentProvider === "gemini" ? "Gemini" : session.agentProvider === "grok" ? "Grok" : "Codex"} 图形`;
}
function matchesTemplateSearch(template: SavedTemplate, searchQuery: string) {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return true;
  return [template.title, template.type, template.cwd, template.wslDistro, template.sshEndpoint, ...(template.tags ?? [])]
    .some(value => value?.toLowerCase().includes(query));
}

export function SessionHome({ closeCompleted, sessions, overviews, activeId, onOpen, onAction, onChooseTemplate, onOpenTasks }: {
  closeCompleted: ReturnType<typeof useCloseCompleted>; sessions: RuntimeSession[]; overviews: Record<string, SessionOverview>; activeId: string | null;
  onOpen: (id: string) => void; onAction: SessionAction; onChooseTemplate: () => void; onOpenTasks: () => void;
}) {
  return <section className="mobile-home">
    <div className="mobile-home-heading"><span>会话总览</span><div className="mobile-home-title"><h1>运行中的会话</h1><strong aria-label={`${sessions.length} 个会话`}>{sessions.length}</strong></div></div>
    <div className="mobile-home-toolbar"><button type="button" className="mobile-files-button" onClick={onOpenTasks}>任务列表</button><CloseCompletedAction controller={closeCompleted} /></div>
    {sessions.length ? <div className="mobile-home-list">{sessions.map(session => {
      const overview = overviews[session.id];
      return <article className={session.id === activeId ? "mobile-home-card selected" : "mobile-home-card"} key={session.id}>
        <div className="mobile-home-card-top">
          <button type="button" className="mobile-home-card-title" onClick={() => onOpen(session.id)} aria-label={`打开${session.title}详情`} title={session.title}>{session.title}</button>
          <div className="mobile-home-card-actions">
            <button type="button" aria-label={`改名${session.title}`} title="改名" onClick={event => onAction("rename", session, event.currentTarget)}><Pencil aria-hidden="true" /></button>
            <button type="button" className="danger" aria-label={`关闭${session.title}`} title="关闭" onClick={event => onAction("close", session, event.currentTarget)}><X aria-hidden="true" /></button>
          </div>
        </div>
        <button type="button" className="mobile-home-card-main" onClick={() => onOpen(session.id)} aria-label={`查看${session.title}最近内容`}>
          <div className="mobile-home-card-meta"><span className="mobile-home-kind">{modeLabel(session)} · {kindLabel(session.type)}</span><span className="mobile-home-status" data-status={overview?.status} title={overview?.detail ?? overview?.status}>{overview?.detail ?? overview?.status ?? "获取状态中"}</span></div>
          <p>{overview?.summary ?? "正在获取最近内容…"}</p>
        </button>
      </article>;
    })}</div> : <div className="mobile-home-empty"><h2>没有运行中的会话</h2><p>从电脑已保存的模板启动一个会话。</p><button className="primary large" type="button" onClick={onChooseTemplate}>选择模板</button></div>}
  </section>;
}

export function SessionDrawer({ closeCompleted, sessions, templates, activeId, tab, onTabChange, send, onOpen, onAction, onClose }: {
  closeCompleted: ReturnType<typeof useCloseCompleted>; sessions: RuntimeSession[]; templates: SavedTemplate[]; activeId: string | null;
  tab: "running" | "templates"; onTabChange: (tab: "running" | "templates") => void;
  send: (message: ClientMessage) => boolean; onOpen: (id: string) => void; onAction: SessionAction; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const drawerRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const drawer = drawerRef.current;
    const backdrop = drawer?.parentElement;
    if (!drawer || !backdrop?.parentElement) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = Array.from(backdrop.parentElement.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop
        && !element.classList.contains("session-dialog-backdrop"))
      .map(element => ({ element, inert: element.inert }));
    drawer.querySelector<HTMLButtonElement>("button")?.focus();
    background.forEach(({ element }) => { element.inert = true; });
    return () => {
      background.forEach(({ element, inert }) => { element.inert = inert; });
      const target = opener?.isConnected ? opener : backdrop.parentElement?.querySelector<HTMLElement>(".menu-button");
      target?.focus();
    };
  }, []);
  const filteredTemplates = useMemo(() => templates.filter(template => matchesTemplateSearch(template, query)), [templates, query]);
  useEffect(() => { if (tab !== "templates") setQuery(""); }, [tab]);
  const launchTemplate = (templateId: string) => {
    const width = Math.max(20, Math.floor(window.innerWidth / 8));
    const height = Math.max(5, Math.floor((window.innerHeight - 150) / 18));
    send({ v: PROTOCOL_VERSION, type: "template.launch", templateId, cols: width, rows: height, requestId: createRequestId() });
    onTabChange("running");
  };
  return <div className="drawer-backdrop" onClick={onClose}>
    <aside ref={drawerRef} className="session-drawer" role="dialog" aria-modal="true" aria-label="会话列表" tabIndex={-1}
      onClick={event => event.stopPropagation()} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
        if (event.key !== "Tab") return;
        const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"))
          .filter(element => element.tabIndex >= 0 && !element.closest("[inert]"));
        const first = elements[0], last = elements.at(-1);
        if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
          event.preventDefault(); first.focus();
        }
      }}>
      <header><h2>会话</h2><button type="button" aria-label="关闭会话列表" onClick={onClose}><X aria-hidden="true" /></button></header>
      <nav>
        <button className={tab === "running" ? "active" : ""} type="button" onClick={() => onTabChange("running")}>运行中 ({sessions.length})</button>
        <button className={tab === "templates" ? "active" : ""} type="button" onClick={() => onTabChange("templates")}>已保存模板 ({templates.length})</button>
      </nav>
      {tab === "running" && <CloseCompletedAction controller={closeCompleted} />}
      {tab === "templates" && <div className="template-search">
        <input type="search" aria-label="搜索已保存模板" placeholder="搜索模板或标签..." value={query} onChange={event => setQuery(event.target.value)} />
        {query && <button type="button" onClick={() => setQuery("")} aria-label="清除模板搜索">清除</button>}
      </div>}
      <div className="session-list">
        {tab === "running" ? sessions.map(session => <article className={session.id === activeId ? "session-card selected" : "session-card"} key={session.id}>
          <button className="session-main" type="button" onClick={() => onOpen(session.id)}>
            <strong>{session.title}</strong><span>{kindLabel(session.type)} · {modeLabel(session)}{session.cwd ? ` · ${session.cwd}` : ""}</span>
          </button>
          <div className="session-actions"><button type="button" onClick={event => onAction("rename", session, event.currentTarget)}>改名</button><button className="danger" type="button" onClick={event => onAction("close", session, event.currentTarget)}>关闭</button></div>
        </article>) : filteredTemplates.map(template => <article className="session-card" key={template.id}>
          <div className="session-main static"><strong>{template.title}</strong><span>{kindLabel(template.type)} · {modeLabel(template)}{template.runningCount ? ` · 已运行 ${template.runningCount}` : ""}</span></div>
          <div className="session-actions"><button className="primary" type="button" onClick={() => launchTemplate(template.id)}>启动</button></div>
        </article>)}
        {tab === "running" && sessions.length === 0 && <p className="drawer-empty">暂无运行会话</p>}
        {tab === "templates" && templates.length === 0 && <p className="drawer-empty">请先在电脑端创建会话模板</p>}
        {tab === "templates" && templates.length > 0 && filteredTemplates.length === 0 && <p className="drawer-empty">没有匹配的模板</p>}
      </div>
      <footer>
        当前会话选择仅影响手机，不会切换电脑页面。
      </footer>
    </aside>
  </div>;
}
