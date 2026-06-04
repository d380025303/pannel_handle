import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import type { TerminalSession } from "./vite-env";

type TerminalEntry = {
  terminal: Terminal;
  fitAddon: FitAddon;
  mountedSessionId?: string;
};

function createTerminalEntry() {
  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: "Cascadia Mono, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.2,
    theme: {
      background: "#101318",
      foreground: "#e7edf4",
      cursor: "#ffffff",
      selectionBackground: "#35506c",
      black: "#15191f",
      red: "#df6b75",
      green: "#76c38f",
      yellow: "#d7b46a",
      blue: "#6ca8e7",
      magenta: "#c792ea",
      cyan: "#64c9cf",
      white: "#e7edf4",
      brightBlack: "#626a73",
      brightRed: "#f07f89",
      brightGreen: "#8ad9a4",
      brightYellow: "#e8c981",
      brightBlue: "#82bbf7",
      brightMagenta: "#d7a5f4",
      brightCyan: "#80dde1",
      brightWhite: "#ffffff"
    }
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  return { terminal, fitAddon };
}

export function App() {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [editDialogSession, setEditDialogSession] = useState<TerminalSession | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editCommand, setEditCommand] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [commandInput, setCommandInput] = useState("");
  const [selectedShellId, setSelectedShellId] = useState('powershell');
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  const [isMaximized, setIsMaximized] = useState(false);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalsRef = useRef(new Map<string, TerminalEntry>());

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeId),
    [activeId, sessions]
  );

  useEffect(() => {
    let isDisposed = false;

    window.windowApi.isMaximized().then((nextIsMaximized) => {
      if (!isDisposed) {
        setIsMaximized(nextIsMaximized);
      }
    });

    const removeMaximizedListener = window.windowApi.onMaximizedChanged(setIsMaximized);

    return () => {
      isDisposed = true;
      removeMaximizedListener();
    };
  }, []);

  useEffect(() => {
    let isDisposed = false;

    window.terminalApi.listSessions().then((nextSessions) => {
      if (isDisposed) {
        return;
      }
      setSessions(nextSessions);
      setActiveId((current) => current || nextSessions[0]?.id);
    });

    const removeSessionsListener = window.terminalApi.onSessionsChanged((nextSessions) => {
      setSessions(nextSessions);
      setActiveId((current) => {
        if (current && nextSessions.some((session) => session.id === current)) {
          return current;
        }
        return nextSessions[0]?.id;
      });
    });

    const removeDataListener = window.terminalApi.onData(({ id, data }) => {
      const entry = terminalsRef.current.get(id);
      if (entry) {
        entry.terminal.write(data);
      }
    });

    const removeExitListener = window.terminalApi.onExit(({ id, exitCode }) => {
      const entry = terminalsRef.current.get(id);
      if (entry) {
        entry.terminal.writeln(`\r\n[进程已退出，退出码 ${exitCode}]`);
      }
    });

    return () => {
      isDisposed = true;
      removeSessionsListener();
      removeDataListener();
      removeExitListener();
    };
  }, []);

  useEffect(() => {
    if (!activeId || !terminalHostRef.current) {
      return;
    }

    terminalHostRef.current.replaceChildren();
    let entry = terminalsRef.current.get(activeId);

    if (!entry) {
      entry = createTerminalEntry();
      entry.terminal.onData((data) => {
        window.terminalApi.write(activeId, data);
      });
      terminalsRef.current.set(activeId, entry);

      window.terminalApi.getHistory(activeId).then((history) => {
        if (history) {
          entry?.terminal.write(history);
        }
      });
    }

    entry.terminal.open(terminalHostRef.current);
    entry.mountedSessionId = activeId;

    const fit = () => {
      try {
        entry?.fitAddon.fit();
        const dims = entry?.fitAddon.proposeDimensions();
        if (dims) {
          window.terminalApi.resize(activeId, dims.cols, dims.rows);
        }
      } catch {
        // xterm can throw while the host is hidden during fast session switches.
      }
    };

    fit();
    entry.terminal.focus();
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(terminalHostRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [activeId]);

  async function handleCreateSession(initialCommand?: string) {
    const isWsl = selectedShellId.startsWith('wsl:');
    const session = await window.terminalApi.createSession({
      type: isWsl ? 'wsl' : 'windows',
      ...(isWsl ? { wslDistro: selectedShellId.slice(4) } : {}),
      ...(initialCommand ? { initialCommand } : {})
    });
    setActiveId(session.id);
    setSelectedShellId('powershell');
  }

  async function handleCloseSession(id: string) {
    await window.terminalApi.closeSession(id);
    const entry = terminalsRef.current.get(id);
    if (entry) {
      entry.terminal.dispose();
      terminalsRef.current.delete(id);
    }
  }

  async function handleSaveEdit() {
    if (!editDialogSession) return;
    await window.terminalApi.updateSession(editDialogSession.id, {
      title: editTitle,
      initialCommand: editCommand.trim() || undefined
    });
    setEditDialogSession(null);
  }

  return (
    <>
      <div className="app-frame">
        <header className="custom-titlebar" onDoubleClick={() => window.windowApi.toggleMaximize()}>
          <div className="titlebar-brand">Pannel Handle</div>
          <div className="titlebar-session">{activeSession?.title || "No active session"}</div>
          <div className="window-controls" onDoubleClick={(event) => event.stopPropagation()}>
            <button
              className="window-control"
              type="button"
              title="Minimize"
              aria-label="Minimize window"
              onClick={() => window.windowApi.minimize()}
            >
              -
            </button>
            <button
              className="window-control"
              type="button"
              title={isMaximized ? "Restore" : "Maximize"}
              aria-label={isMaximized ? "Restore window" : "Maximize window"}
              onClick={() => window.windowApi.toggleMaximize()}
            >
              {isMaximized ? "\u2750" : "\u25a1"}
            </button>
            <button
              className="window-control close"
              type="button"
              title="Close"
              aria-label="Close window"
              onClick={() => window.windowApi.close()}
            >
              {"\u00d7"}
            </button>
          </div>
        </header>

        <main className="app-shell">
        <aside className="session-sidebar">
          <div className="sidebar-header">
            <div>
              <h1>命令会话</h1>
              <span>{sessions.length} 个窗口</span>
            </div>
            <button className="icon-button primary" type="button" title="新建会话" onClick={async () => {
              setShowModal(true);
              const distros = await window.terminalApi.listWslDistros();
              setWslDistros(distros);
              setSelectedShellId(distros.length > 0 ? `wsl:${distros[0]}` : 'powershell');
            }}>
              +
            </button>
          </div>

          <div className="session-list">
            {sessions.map((session) => (
              <button
                className={`session-item ${session.id === activeId ? "active" : ""}`}
                key={session.id}
                type="button"
                onClick={() => setActiveId(session.id)}
              >
                <span className="session-main">
                  <span className="session-title">
                    {session.title}
                    <span className={`session-type-badge ${session.type}`}>
                      {session.type === 'wsl' ? (session.wslDistro || 'WSL') : 'PS'}
                    </span>
                  </span>
                </span>
                <span className="session-actions">
                  <span
                    className="mini-action"
                    title="编辑会话"
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditDialogSession(session);
                      setEditTitle(session.title);
                      setEditCommand(session.initialCommand || "");
                    }}
                  >
                    R
                  </span>
                  <span
                    className="mini-action danger"
                    title="关闭"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleCloseSession(session.id);
                    }}
                  >
                    X
                  </span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="terminal-panel">
          <header className="terminal-header">
            <div>
              <h2>{activeSession?.title || "未选择会话"}</h2>
              <span>{activeSession ? (activeSession.type === 'wsl' ? `WSL - ${activeSession.wslDistro || 'Linux'}` : 'PowerShell') : '没有正在运行的命令窗口'}</span>
            </div>
          </header>
          <div className="terminal-host" ref={terminalHostRef} />
        </section>
        </main>
      </div>

    {showModal && (
      <div className="modal-overlay" onClick={() => { setShowModal(false); setCommandInput(""); }}>
        <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>新建会话</h3>
          </div>
          <div className="modal-body">
            <div className="shell-list">
              <button
                type="button"
                className={`shell-item ${selectedShellId === 'powershell' ? 'selected' : ''}`}
                onClick={() => setSelectedShellId('powershell')}
              >
                PowerShell
              </button>
              {wslDistros.map((distro) => {
                const id = `wsl:${distro}`;
                return (
                  <button
                    key={distro}
                    type="button"
                    className={`shell-item ${selectedShellId === id ? 'selected' : ''}`}
                    onClick={() => setSelectedShellId(id)}
                  >
                    {distro}
                  </button>
                );
              })}
            </div>
            <input
              autoFocus
              className="modal-input"
              placeholder="输入初始命令（可选），如：cd D:\\projects\\myapp"
              value={commandInput}
              onChange={(e) => setCommandInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleCreateSession(commandInput.trim() || undefined);
                  setShowModal(false);
                  setCommandInput("");
                }
                if (e.key === "Escape") {
                  setShowModal(false);
                  setCommandInput("");
                }
              }}
            />
          </div>
          <div className="modal-footer">
            <button
              className="modal-button"
              type="button"
              onClick={() => { setShowModal(false); setCommandInput(""); }}
            >
              取消
            </button>
            <button
              className="modal-button primary"
              type="button"
              onClick={() => {
                handleCreateSession(commandInput.trim() || undefined);
                setShowModal(false);
                setCommandInput("");
              }}
            >
              创建
            </button>
          </div>
        </div>
      </div>
    )}

    {editDialogSession && (
      <div className="modal-overlay" onClick={() => setEditDialogSession(null)}>
        <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>编辑会话</h3>
          </div>
          <div className="modal-body">
            <label className="modal-label">会话名称</label>
            <input
              autoFocus
              className="modal-input"
              placeholder="输入会话名称"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
            />
            <label className="modal-label" style={{ marginTop: "12px" }}>
              初始命令
            </label>
            <input
              className="modal-input"
              placeholder="输入初始命令（可选），如：cd D:\\projects\\myapp"
              value={editCommand}
              onChange={(e) => setEditCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSaveEdit();
                }
                if (e.key === "Escape") {
                  setEditDialogSession(null);
                }
              }}
            />
          </div>
          <div className="modal-footer">
            <button className="modal-button" type="button" onClick={() => setEditDialogSession(null)}>
              取消
            </button>
            <button className="modal-button primary" type="button" onClick={handleSaveEdit}>
              保存
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
