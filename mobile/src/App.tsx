import { useState } from "react";
import { TerminalView } from "./TerminalView";
import { GraphicalView } from "./GraphicalView";
import { ComputerFiles } from "./ComputerFiles";
import { SessionHome, SessionDrawer } from "./SessionList";
import { SessionActionDialog, useSessionActionDialog } from "./SessionActionDialog";
import { useSessionDrafts } from "./useSessionDrafts";
import { useSessionNavigation } from "./useSessionNavigation";
import { useRemoteConnection } from "./useRemoteConnection";
import { useMobilePreferences } from "./useMobilePreferences";

export default function App() {
  const remote = useRemoteConnection();
  const preferences = useMobilePreferences();
  const navigation = useSessionNavigation(remote.sessions, remote.status, remote.lastLaunchedId);
  const drafts = useSessionDrafts(remote.sessions, remote.status, remote.onGraphicalMessage);
  const dialog = useSessionActionDialog(remote.send);
  const [drawerTab, setDrawerTab] = useState<"running" | "templates">("running");
  const [password, setPassword] = useState("");
  const { view, setView, filesOpen, setFilesOpen, drawerOpen, setDrawerOpen, activeId, activeSession, openSession } = navigation;

  const chooseTemplate = () => { setDrawerTab("templates"); setDrawerOpen(true); };

  if (remote.status !== "connected" && !remote.device) {
    return <main className="connection-page">
      <div className="brand-mark">PH</div>
      <h1>Pannel Handle</h1>
      <p className="connection-state">{remote.statusMessage}</p>
      {remote.status === "password-required" && <form className="mobile-login" onSubmit={event => { event.preventDefault(); if (password) remote.login(password); setPassword(""); }}>
        <input type="password" autoComplete="current-password" aria-label="移动访问密码" value={password} onChange={event => setPassword(event.target.value)} placeholder="移动访问密码" />
        <button className="primary large" type="submit" disabled={!password}>验证并连接</button>
        <small>验证成功后，密码会保存在此浏览器中，刷新页面可自动连接。</small>
      </form>}
      {(remote.status === "error" || remote.status === "disconnected") && <button className="primary large" type="button" onClick={remote.retry}>重新连接</button>}
      {remote.storageWarning && <p role="alert">{remote.storageWarning}</p>}
      <aside className="security-warning">当前版本使用局域网 HTTP 明文连接。只应在你信任的私人网络中使用，不要映射到互联网。</aside>
    </main>;
  }

  return <main className="app-shell">
    <header className="app-header">
      {view === "detail" && !filesOpen && <button type="button" className="home-button" onClick={() => setView("home")} aria-label="返回首页">‹</button>}
      <button type="button" className="menu-button" onClick={() => setDrawerOpen(true)} aria-label="打开会话列表">☰</button>
      <div className="app-title"><strong>Pannel Handle</strong><span><i />{remote.device?.deviceName ?? "移动设备"}</span></div>
      <button type="button" className="mobile-files-button" onClick={() => setFilesOpen(current => !current)}>{filesOpen ? "会话" : "电脑文件"}</button>
      <span className="http-badge">HTTP 局域网</span>
    </header>
    {remote.commandError && <div className="command-error" role="alert">{remote.commandError}</div>}
    {remote.storageWarning && <div className="command-error" role="alert">{remote.storageWarning}</div>}
    {drafts.recoveryNotice && <div className="command-error" role="alert">{drafts.recoveryNotice}<button type="button" onClick={() => drafts.setRecoveryNotice("")}>关闭</button></div>}

    {filesOpen ? <ComputerFiles connectionEpoch={remote.connectionEpoch} send={remote.send} onFileMessage={remote.onFileMessage} onClose={() => setFilesOpen(false)} />
      : view === "home" ? <SessionHome sessions={remote.sessions} overviews={remote.overviews} activeId={activeId}
        onOpen={openSession} onAction={dialog.open} onChooseTemplate={chooseTemplate} />
      : activeSession?.runtimeMode === "app-server" ? <GraphicalView key={activeSession.id} session={activeSession} graphicalMenuConfig={remote.graphicalMenuConfig}
        minimalMode={preferences.minimalMode}
        connectionEpoch={remote.status === "connected" ? remote.connectionEpoch : 0} send={remote.send} onGraphicalMessage={remote.onGraphicalMessage}
        draft={drafts.graphicalDrafts[activeSession.id]?.text ?? ""}
        setDraft={update => drafts.updateGraphicalDraft(activeSession.id, update)}
        submissionPending={Boolean(drafts.pendingBySession[activeSession.id])}
        onSubmitRequest={requestId => drafts.trackGraphicalSubmit(activeSession.id, requestId)} />
      : activeSession ? <TerminalView key={activeSession.id} session={activeSession} deviceId={remote.device?.deviceId}
        connectionEpoch={remote.connectionEpoch} send={remote.send} onTerminalMessage={remote.onTerminalMessage}
        pasteText={drafts.pasteDrafts[activeSession.id] ?? ""}
        setPasteText={update => drafts.setPasteText(activeSession.id, update)}
        pasteOpen={Boolean(drafts.pasteOpenBySession[activeSession.id])}
        setPasteOpen={open => drafts.setPasteOpen(activeSession.id, open)} />
      : <section className="empty-terminal"><h2>没有运行中的会话</h2><p>从电脑已保存的模板启动一个会话。</p>
          <button className="primary large" type="button" onClick={chooseTemplate}>选择模板</button></section>}

    {drawerOpen && <SessionDrawer sessions={remote.sessions} templates={remote.templates} activeId={activeId}
      minimalMode={preferences.minimalMode} onMinimalModeChange={preferences.updateMinimalMode} preferencesWarning={preferences.storageWarning}
      tab={drawerTab} onTabChange={setDrawerTab} send={remote.send} onOpen={openSession}
      onAction={dialog.open} onClose={() => setDrawerOpen(false)} />}
    <SessionActionDialog dialog={dialog} />
    {remote.status !== "connected" && <div className="connection-overlay" role="status">
      <div><strong>正在恢复连接</strong><p>{remote.statusMessage}</p>
        <button className="primary large" type="button" onClick={remote.retry}>立即重试</button></div>
    </div>}
  </main>;
}
