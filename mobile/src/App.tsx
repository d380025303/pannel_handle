import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { TerminalView } from "./TerminalView";
import { GraphicalView } from "./GraphicalView";
import { ComputerFiles } from "./ComputerFiles";
import { createRequestId } from "./protocol";
import { PROTOCOL_VERSION, type RuntimeSession, type SavedTemplate } from "./types";
import { useRemoteConnection } from "./useRemoteConnection";

const ACTIVE_SESSION_STORAGE_KEY = "pannel-handle-mobile-active-session";
type TextDraft = { text: string; version: number };

function readActiveSessionId() {
  try { return localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY); }
  catch { return null; }
}

function kindLabel(type: RuntimeSession["type"]) {
  if (type === "windows") return "Windows";
  if (type === "wsl") return "WSL";
  return "SSH";
}
function modeLabel(session: { runtimeMode: string; agentProvider?: string }) {
  if (session.runtimeMode !== "app-server") return "终端";
  return `${session.agentProvider === "codebuddy" ? "CodeBuddy" : session.agentProvider === "opencode" ? "OpenCode" : session.agentProvider === "claude" ? "Claude" : session.agentProvider === "qoder" ? "Qoder" : session.agentProvider === "gemini" ? "Gemini" : "Codex"} 图形`;
}

function matchesTemplateSearch(template: SavedTemplate, searchQuery: string) {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return true;
  return [template.title, template.type, template.cwd, template.wslDistro, template.sshEndpoint, ...(template.tags ?? [])]
    .some(value => value?.toLowerCase().includes(query));
}

export default function App() {
  const remote = useRemoteConnection();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"running" | "templates">("running");
  const [templateQuery, setTemplateQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(readActiveSessionId);
  const handledLaunchedId = useRef<string | null>(null);
  const [password, setPassword] = useState("");
  const [graphicalDrafts, setGraphicalDrafts] = useState<Record<string, TextDraft>>({});
  const [pasteDrafts, setPasteDrafts] = useState<Record<string, string>>({});
  const [pasteOpenBySession, setPasteOpenBySession] = useState<Record<string, boolean>>({});
  const [pendingBySession, setPendingBySession] = useState<Record<string, string>>({});
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const pendingSubmissions = useRef(new Map<string, { sessionId: string; version: number }>());
  const activeSession = useMemo(
    () => remote.sessions.find((session) => session.id === activeId) ?? null,
    [activeId, remote.sessions]
  );
  const filteredTemplates = useMemo(
    () => remote.templates.filter(template => matchesTemplateSearch(template, templateQuery)),
    [remote.templates, templateQuery]
  );

  useEffect(() => {
    if (!drawerOpen || drawerTab !== "templates") setTemplateQuery("");
  }, [drawerOpen, drawerTab]);

  useEffect(() => {
    if (remote.status !== "connected") return;
    if (activeId && remote.sessions.some((session) => session.id === activeId)) return;
    setActiveId(remote.sessions[0]?.id ?? null);
  }, [activeId, remote.sessions, remote.status]);

  useEffect(() => {
    if (remote.lastLaunchedId && handledLaunchedId.current !== remote.lastLaunchedId
      && remote.sessions.some((session) => session.id === remote.lastLaunchedId)) {
      handledLaunchedId.current = remote.lastLaunchedId;
      setActiveId(remote.lastLaunchedId);
      setDrawerOpen(false);
    }
  }, [remote.lastLaunchedId, remote.sessions]);

  useEffect(() => {
    if (remote.status !== "connected") return;
    if (activeId && !remote.sessions.some((session) => session.id === activeId)) return;
    try {
      if (activeId) localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, activeId);
      else localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    } catch { /* Session selection still works when browser storage is unavailable. */ }
  }, [activeId, remote.sessions, remote.status]);

  const updateGraphicalDraft = useCallback((sessionId: string, update: SetStateAction<string>) => {
    setGraphicalDrafts(current => {
      const previous = current[sessionId] ?? { text: "", version: 0 };
      const text = typeof update === "function" ? update(previous.text) : update;
      if (text === previous.text) return current;
      return { ...current, [sessionId]: { text, version: previous.version + 1 } };
    });
  }, []);

  useEffect(() => {
    const unsubscribe = remote.onGraphicalMessage(message => {
      if (message.type !== "command.ok" && message.type !== "error") return;
      if (!message.requestId) return;
      const pending = pendingSubmissions.current.get(message.requestId);
      if (!pending) return;
      pendingSubmissions.current.delete(message.requestId);
      setPendingBySession(current => {
        if (current[pending.sessionId] !== message.requestId) return current;
        const next = { ...current };
        delete next[pending.sessionId];
        return next;
      });
      if (message.type === "command.ok") setGraphicalDrafts(current => {
        const draft = current[pending.sessionId];
        if (!draft || draft.version !== pending.version) return current;
        return { ...current, [pending.sessionId]: { text: "", version: draft.version + 1 } };
      });
    });
    return () => { unsubscribe(); };
  }, [remote.onGraphicalMessage]);

  useEffect(() => {
    if (remote.status !== "connected") return;
    const ids = new Set(remote.sessions.map(session => session.id));
    setGraphicalDrafts(current => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
    setPasteDrafts(current => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
    setPasteOpenBySession(current => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
    setPendingBySession(current => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
    for (const [requestId, pending] of pendingSubmissions.current) {
      if (!ids.has(pending.sessionId)) pendingSubmissions.current.delete(requestId);
    }
  }, [remote.sessions, remote.status]);

  useEffect(() => {
    if (remote.status === "connected" || pendingSubmissions.current.size === 0) return;
    pendingSubmissions.current.clear();
    setPendingBySession({});
    setRecoveryNotice("连接中断，发送结果未确认；请核对会话内容后再重试。草稿已保留。");
  }, [remote.status]);

  const trackGraphicalSubmit = (sessionId: string, requestId: string) => {
    pendingSubmissions.current.set(requestId, { sessionId, version: graphicalDrafts[sessionId]?.version ?? 0 });
    setPendingBySession(current => ({ ...current, [sessionId]: requestId }));
  };

  const launchTemplate = (templateId: string) => {
    const width = Math.max(20, Math.floor(window.innerWidth / 8));
    const height = Math.max(5, Math.floor((window.innerHeight - 150) / 18));
    remote.send({
      v: PROTOCOL_VERSION,
      type: "template.launch",
      templateId,
      cols: width,
      rows: height,
      requestId: createRequestId()
    });
    setDrawerTab("running");
  };

  const renameSession = (session: RuntimeSession) => {
    const title = window.prompt("新的会话名称", session.title)?.trim();
    if (!title || title === session.title) return;
    remote.send({ v: PROTOCOL_VERSION, type: "session.rename", sessionId: session.id, title, requestId: createRequestId() });
  };

  const closeSession = (session: RuntimeSession) => {
    if (!window.confirm(`关闭“${session.title}”会终止正在运行的会话，是否继续？`)) return;
    remote.send({ v: PROTOCOL_VERSION, type: "session.close", sessionId: session.id, requestId: createRequestId() });
  };

  if (remote.status !== "connected" && !remote.device) {
    return (
      <main className="connection-page">
        <div className="brand-mark">PH</div>
        <h1>Pannel Handle</h1>
        <p className="connection-state">{remote.statusMessage}</p>
        {remote.status === "password-required" && <form className="mobile-login" onSubmit={(event) => { event.preventDefault(); if (password) remote.login(password); setPassword(""); }}>
          <input type="password" autoComplete="current-password" aria-label="移动访问密码" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="移动访问密码" />
          <button className="primary large" type="submit" disabled={!password}>验证并连接</button>
          <small>验证成功后，密码会保存在此浏览器中，刷新页面可自动连接。</small>
        </form>}
        {(remote.status === "error" || remote.status === "disconnected") && <button className="primary large" type="button" onClick={remote.retry}>重新连接</button>}
        {remote.storageWarning && <p role="alert">{remote.storageWarning}</p>}
        <aside className="security-warning">当前版本使用局域网 HTTP 明文连接。只应在你信任的私人网络中使用，不要映射到互联网。</aside>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <button type="button" className="menu-button" onClick={() => setDrawerOpen(true)} aria-label="打开会话列表">☰</button>
        <div className="app-title"><strong>Pannel Handle</strong><span><i />{remote.device?.deviceName ?? "移动设备"}</span></div>
        <button type="button" className="mobile-files-button" onClick={() => setFilesOpen(current => !current)}>{filesOpen ? "会话" : "电脑文件"}</button>
        <span className="http-badge">HTTP 局域网</span>
      </header>
      {remote.commandError && <div className="command-error" role="alert">{remote.commandError}</div>}
      {remote.storageWarning && <div className="command-error" role="alert">{remote.storageWarning}</div>}
      {recoveryNotice && <div className="command-error" role="alert">{recoveryNotice}<button type="button" onClick={() => setRecoveryNotice("")}>关闭</button></div>}

      {filesOpen ? <ComputerFiles connectionEpoch={remote.connectionEpoch} send={remote.send} onFileMessage={remote.onFileMessage} onClose={() => setFilesOpen(false)} /> : activeSession?.runtimeMode === "app-server" ? (
        <GraphicalView key={activeSession.id} session={activeSession} connectionEpoch={remote.connectionEpoch} send={remote.send} onGraphicalMessage={remote.onGraphicalMessage}
          draft={graphicalDrafts[activeSession.id]?.text ?? ""}
          setDraft={update => updateGraphicalDraft(activeSession.id, update)}
          submissionPending={Boolean(pendingBySession[activeSession.id])}
          onSubmitRequest={requestId => trackGraphicalSubmit(activeSession.id, requestId)} />
      ) : activeSession ? (
        <TerminalView
          key={activeSession.id}
          session={activeSession}
          deviceId={remote.device?.deviceId}
          connectionEpoch={remote.connectionEpoch}
          send={remote.send}
          onTerminalMessage={remote.onTerminalMessage}
          pasteText={pasteDrafts[activeSession.id] ?? ""}
          setPasteText={update => setPasteDrafts(current => ({ ...current, [activeSession.id]: typeof update === "function" ? update(current[activeSession.id] ?? "") : update }))}
          pasteOpen={Boolean(pasteOpenBySession[activeSession.id])}
          setPasteOpen={open => setPasteOpenBySession(current => ({ ...current, [activeSession.id]: open }))}
        />
      ) : (
        <section className="empty-terminal">
          <h2>没有运行中的会话</h2>
          <p>从电脑已保存的模板启动一个会话。</p>
          <button className="primary large" type="button" onClick={() => { setDrawerTab("templates"); setDrawerOpen(true); }}>选择模板</button>
        </section>
      )}

      {drawerOpen && (
        <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)}>
          <aside className="session-drawer" onClick={(event) => event.stopPropagation()}>
            <header><h2>会话</h2><button type="button" onClick={() => setDrawerOpen(false)}>×</button></header>
            <nav>
              <button className={drawerTab === "running" ? "active" : ""} type="button" onClick={() => setDrawerTab("running")}>运行中 ({remote.sessions.length})</button>
              <button className={drawerTab === "templates" ? "active" : ""} type="button" onClick={() => setDrawerTab("templates")}>已保存模板 ({remote.templates.length})</button>
            </nav>
            {drawerTab === "templates" && <div className="template-search">
              <input type="search" aria-label="搜索已保存模板" placeholder="搜索模板或标签..." value={templateQuery} onChange={event => setTemplateQuery(event.target.value)} />
              {templateQuery && <button type="button" onClick={() => setTemplateQuery("")} aria-label="清除模板搜索">清除</button>}
            </div>}
            <div className="session-list">
              {drawerTab === "running" ? remote.sessions.map((session) => (
                <article className={session.id === activeId ? "session-card selected" : "session-card"} key={session.id}>
                  <button className="session-main" type="button" onClick={() => { setActiveId(session.id); setDrawerOpen(false); }}>
                    <strong>{session.title}</strong><span>{kindLabel(session.type)} · {modeLabel(session)}{session.cwd ? ` · ${session.cwd}` : ""}</span>
                  </button>
                  <div className="session-actions"><button type="button" onClick={() => renameSession(session)}>改名</button><button className="danger" type="button" onClick={() => closeSession(session)}>关闭</button></div>
                </article>
              )) : filteredTemplates.map((template) => (
                <article className="session-card" key={template.id}>
                  <div className="session-main static"><strong>{template.title}</strong><span>{kindLabel(template.type)} · {modeLabel(template)}{template.runningCount ? ` · 已运行 ${template.runningCount}` : ""}</span></div>
                  <div className="session-actions"><button className="primary" type="button" onClick={() => launchTemplate(template.id)}>启动</button></div>
                </article>
              ))}
              {drawerTab === "running" && remote.sessions.length === 0 && <p className="drawer-empty">暂无运行会话</p>}
              {drawerTab === "templates" && remote.templates.length === 0 && <p className="drawer-empty">请先在电脑端创建会话模板</p>}
              {drawerTab === "templates" && remote.templates.length > 0 && filteredTemplates.length === 0 && <p className="drawer-empty">没有匹配的模板</p>}
            </div>
            <footer>当前会话选择仅影响手机，不会切换电脑页面。</footer>
          </aside>
        </div>
      )}
      {remote.status !== "connected" && <div className="connection-overlay" role="status">
        <div><strong>正在恢复连接</strong><p>{remote.statusMessage}</p>
          <button className="primary large" type="button" onClick={remote.retry}>立即重试</button></div>
      </div>}
    </main>
  );
}
