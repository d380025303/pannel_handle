import { useEffect, useMemo, useState } from "react";
import { TerminalView } from "./TerminalView";
import { PROTOCOL_VERSION, type RuntimeSession } from "./types";
import { useRemoteConnection } from "./useRemoteConnection";

function requestId() {
  return crypto.randomUUID();
}
function kindLabel(type: RuntimeSession["type"]) {
  if (type === "windows") return "Windows";
  if (type === "wsl") return "WSL";
  return "SSH";
}

export default function App() {
  const remote = useRemoteConnection();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"running" | "templates">("running");
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeSession = useMemo(
    () => remote.sessions.find((session) => session.id === activeId) ?? null,
    [activeId, remote.sessions]
  );

  useEffect(() => {
    if (activeId && remote.sessions.some((session) => session.id === activeId)) return;
    setActiveId(remote.sessions[0]?.id ?? null);
  }, [activeId, remote.sessions]);

  useEffect(() => {
    if (remote.lastLaunchedId && remote.sessions.some((session) => session.id === remote.lastLaunchedId)) {
      setActiveId(remote.lastLaunchedId);
      setDrawerOpen(false);
    }
  }, [remote.lastLaunchedId, remote.sessions]);

  const launchTemplate = (templateId: string) => {
    const width = Math.max(20, Math.floor(window.innerWidth / 8));
    const height = Math.max(5, Math.floor((window.innerHeight - 150) / 18));
    remote.send({
      v: PROTOCOL_VERSION,
      type: "template.launch",
      templateId,
      cols: width,
      rows: height,
      requestId: requestId()
    });
    setDrawerTab("running");
  };

  const renameSession = (session: RuntimeSession) => {
    const title = window.prompt("新的会话名称", session.title)?.trim();
    if (!title || title === session.title) return;
    remote.send({ v: PROTOCOL_VERSION, type: "session.rename", sessionId: session.id, title, requestId: requestId() });
  };

  const closeSession = (session: RuntimeSession) => {
    if (!window.confirm(`关闭“${session.title}”会终止正在运行的终端，是否继续？`)) return;
    remote.send({ v: PROTOCOL_VERSION, type: "session.close", sessionId: session.id, requestId: requestId() });
  };

  if (remote.status !== "connected") {
    return (
      <main className="connection-page">
        <div className="brand-mark">PH</div>
        <h1>Pannel Handle</h1>
        <p className="connection-state">{remote.statusMessage}</p>
        {remote.verificationCode && <div className="verification-code">{remote.verificationCode}</div>}
        {remote.status === "waiting-approval" && <p>请核对电脑弹窗中的设备名称和校验码，然后点击允许。</p>}
        {(remote.status === "error" || remote.status === "disconnected") && <button className="primary large" type="button" onClick={remote.retry}>重新连接</button>}
        <aside className="security-warning">当前版本使用局域网 HTTP 明文连接。只应在你信任的私人网络中使用，不要映射到互联网。</aside>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <button type="button" className="menu-button" onClick={() => setDrawerOpen(true)} aria-label="打开会话列表">☰</button>
        <div className="app-title"><strong>Pannel Handle</strong><span><i />{remote.device?.deviceName ?? "移动设备"}</span></div>
        <span className="http-badge">HTTP 局域网</span>
      </header>
      {remote.commandError && <div className="command-error" role="alert">{remote.commandError}</div>}

      {activeSession ? (
        <TerminalView
          key={activeSession.id}
          session={activeSession}
          deviceId={remote.device?.deviceId}
          send={remote.send}
          onTerminalMessage={remote.onTerminalMessage}
        />
      ) : (
        <section className="empty-terminal">
          <h2>没有运行中的终端</h2>
          <p>从电脑已保存的模板启动一个会话。</p>
          <button className="primary large" type="button" onClick={() => { setDrawerTab("templates"); setDrawerOpen(true); }}>选择模板</button>
        </section>
      )}

      {drawerOpen && (
        <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)}>
          <aside className="session-drawer" onClick={(event) => event.stopPropagation()}>
            <header><h2>终端会话</h2><button type="button" onClick={() => setDrawerOpen(false)}>×</button></header>
            <nav>
              <button className={drawerTab === "running" ? "active" : ""} type="button" onClick={() => setDrawerTab("running")}>运行中 ({remote.sessions.length})</button>
              <button className={drawerTab === "templates" ? "active" : ""} type="button" onClick={() => setDrawerTab("templates")}>已保存模板 ({remote.templates.length})</button>
            </nav>
            <div className="session-list">
              {drawerTab === "running" ? remote.sessions.map((session) => (
                <article className={session.id === activeId ? "session-card selected" : "session-card"} key={session.id}>
                  <button className="session-main" type="button" onClick={() => { setActiveId(session.id); setDrawerOpen(false); }}>
                    <strong>{session.title}</strong><span>{kindLabel(session.type)}{session.cwd ? ` · ${session.cwd}` : ""}</span>
                  </button>
                  <div className="session-actions"><button type="button" onClick={() => renameSession(session)}>改名</button><button className="danger" type="button" onClick={() => closeSession(session)}>关闭</button></div>
                </article>
              )) : remote.templates.map((template) => (
                <article className="session-card" key={template.id}>
                  <div className="session-main static"><strong>{template.title}</strong><span>{kindLabel(template.type)}{template.runningCount ? ` · 已运行 ${template.runningCount}` : ""}</span></div>
                  <div className="session-actions"><button className="primary" type="button" onClick={() => launchTemplate(template.id)}>启动</button></div>
                </article>
              ))}
              {drawerTab === "running" && remote.sessions.length === 0 && <p className="drawer-empty">暂无运行会话</p>}
              {drawerTab === "templates" && remote.templates.length === 0 && <p className="drawer-empty">请先在电脑端创建会话模板</p>}
            </div>
            <footer>当前会话选择仅影响手机，不会切换电脑页面。</footer>
          </aside>
        </div>
      )}
    </main>
  );
}
