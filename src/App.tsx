import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import type { AgentStatusPayload, TerminalSession } from "./vite-env";

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

function getAgentStatusLabel(status?: AgentStatusPayload) {
  if (!status) return "";
  if (status.status === "waiting_for_permission") {
    return status.toolName ? `Claude 等待确认: ${status.toolName}` : "Claude 等待确认";
  }
  if (status.status === "completed") return "Claude 已完成";
  if (status.status === "failed") return "Claude 失败";
  if (status.status === "running") return "运行中";
  if (status.status === "ended") return "Claude 已结束";
  if (status.status === "exited") return "进程已退出";
  return "";
}

function getAgentStatusClass(status?: AgentStatusPayload) {
  return status?.status ?? "unknown";
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
  const [sidebarWidth, setSidebarWidth] = useState(290);
  const [pendingSessions, setPendingSessions] = useState<TerminalSession[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pickerManual, setPickerManual] = useState(false);
  const [agentStatusesBySessionId, setAgentStatusesBySessionId] = useState<Record<string, AgentStatusPayload>>({});
  const draggingRef = useRef(false);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);

  const handleSplitterMouseDown = useCallback(() => {
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: globalThis.MouseEvent) => {
      if (!draggingRef.current) return;
      const newWidth = Math.min(500, Math.max(180, e.clientX));
      setSidebarWidth(newWidth);
    };
    const handleMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);
  const terminalsRef = useRef(new Map<string, TerminalEntry>());

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeId),
    [activeId, sessions]
  );
  const activeAgentStatus = activeId ? agentStatusesBySessionId[activeId] : undefined;
  const activeAgentStatusLabel = getAgentStatusLabel(activeAgentStatus);

  const copyTerminalSelection = useCallback(async (terminal: Terminal) => {
    if (!terminal.hasSelection()) {
      return false;
    }

    const selection = terminal.getSelection();
    if (!selection) {
      return false;
    }

    const didCopy = await window.clipboardApi.writeText(selection);
    if (didCopy) {
      terminal.clearSelection();
    }
    return didCopy;
  }, []);

  const handleTerminalContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();

    const entry = activeId ? terminalsRef.current.get(activeId) : undefined;
    if (!entry) {
      return;
    }

    if (entry.terminal.hasSelection()) {
      void copyTerminalSelection(entry.terminal);
      return;
    }

    entry.terminal.focus();
  }, [activeId, copyTerminalSelection]);

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

    window.terminalApi.loadSavedSessions().then((saved) => {
      if (isDisposed) {
        return;
      }
      if (saved.length > 0) {
        setPendingSessions(saved);
        setSelectedIds(new Set());
        setPickerManual(false);
      } else {
        setPendingSessions(null);
      }
    });

    const removeSessionsListener = window.terminalApi.onSessionsChanged((nextSessions) => {
      setSessions(nextSessions);
      setAgentStatusesBySessionId((current) => {
        const activeSessionIds = new Set(nextSessions.map((session) => session.id));
        return Object.fromEntries(
          Object.entries(current).filter(([id]) => activeSessionIds.has(id))
        );
      });
      setActiveId((current) => {
        if (current && nextSessions.some((session) => session.id === current)) {
          return current;
        }
        return nextSessions[0]?.id;
      });
      setPendingSessions(null);
      setPickerManual(false);
    });

    const removeDataListener = window.terminalApi.onData(({ id, data }) => {
      const entry = terminalsRef.current.get(id);
      if (entry) {
        entry.terminal.write(data);
      }
      setAgentStatusesBySessionId((current) => {
        const status = current[id];
        if (!status || (status.status !== "completed" && status.status !== "failed" && status.status !== "ended")) {
          return current;
        }
        return {
          ...current,
          [id]: {
            id,
            provider: "claude",
            status: "running",
            eventName: "TerminalData",
            timestamp: Date.now()
          }
        };
      });
    });

    const removeExitListener = window.terminalApi.onExit(({ id, exitCode }) => {
      const entry = terminalsRef.current.get(id);
      if (entry) {
        entry.terminal.writeln(`\r\n[进程已退出，退出码 ${exitCode}]`);
      }
    });

    const removeAgentStatusListener = window.terminalApi.onAgentStatus((payload) => {
      setAgentStatusesBySessionId((current) => ({
        ...current,
        [payload.id]: payload
      }));
    });

    return () => {
      isDisposed = true;
      removeSessionsListener();
      removeDataListener();
      removeExitListener();
      removeAgentStatusListener();
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
      entry.terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown" || !event.ctrlKey || event.altKey) {
          return true;
        }

        const isCopyKey = event.key.toLowerCase() === "c";
        if (!isCopyKey) {
          return true;
        }

        const hasSelection = entry?.terminal.hasSelection() ?? false;
        if (event.shiftKey) {
          if (hasSelection && entry) {
            void copyTerminalSelection(entry.terminal);
          }
          return false;
        }

        if (hasSelection && entry) {
          void copyTerminalSelection(entry.terminal);
          return false;
        }

        return true;
      });
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
  }, [activeId, copyTerminalSelection]);

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

  async function handleOpenPicker() {
    const library = await window.terminalApi.loadSavedSessions();
    setPendingSessions(library);
    setSelectedIds(new Set(library.map((s) => s.id)));
    setPickerManual(true);
  }

  async function handleLaunchSelected() {
    const toLaunch = (pendingSessions ?? []).filter(
      (s) => selectedIds.has(s.id)
    );
    await window.terminalApi.launchSessions(toLaunch);
  }

  async function handleStartFresh() {
    await window.terminalApi.launchSessions([]);
  }

  async function handleDeleteFromLibrary(id: string) {
    await window.terminalApi.deleteSavedSession(id);
    setPendingSessions((prev) => prev ? prev.filter((s) => s.id !== id) : null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
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

        <main className="app-shell" style={{ gridTemplateColumns: `${sidebarWidth}px 1px minmax(0, 1fr)` }}>
        <aside className="session-sidebar">
          <div className="sidebar-header">
            <div>
              <h1>命令会话</h1>
              <span>{sessions.length} 个窗口</span>
            </div>
            <button className="icon-button" type="button" title="从库中启动" onClick={handleOpenPicker}>
              {"☰"}
            </button>
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
            {sessions.map((session) => {
              const agentStatus = agentStatusesBySessionId[session.id];
              const agentStatusLabel = getAgentStatusLabel(agentStatus);
              return (
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
                  {agentStatusLabel && (
                    <span className={`agent-status-badge ${getAgentStatusClass(agentStatus)}`}>
                      {agentStatusLabel}
                    </span>
                  )}
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
              );
            })}
          </div>
        </aside>

        <div className="splitter" onMouseDown={handleSplitterMouseDown} />

        <section className="terminal-panel">
          <header className="terminal-header">
            <div>
              <h2>{activeSession?.title || "未选择会话"}</h2>
              <span>{activeSession ? (activeSession.type === 'wsl' ? `WSL - ${activeSession.wslDistro || 'Linux'}` : 'PowerShell') : '没有正在运行的命令窗口'}</span>
            </div>
            {activeAgentStatusLabel && (
              <span className={`terminal-agent-status ${getAgentStatusClass(activeAgentStatus)}`}>
                {activeAgentStatusLabel}
              </span>
            )}
          </header>
          <div className="terminal-host" ref={terminalHostRef} onContextMenu={handleTerminalContextMenu} />
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

    {pendingSessions !== null && (() => {
      const runningCounts = sessions.reduce((counts, session) => {
        if (!session.templateId) {
          return counts;
        }
        counts.set(session.templateId, (counts.get(session.templateId) ?? 0) + 1);
        return counts;
      }, new Map<string, number>());
      const newCount = pendingSessions.filter((s) => selectedIds.has(s.id)).length;

      return (
      <div className="modal-overlay" onClick={() => { setPendingSessions(null); setPickerManual(false); }}>
        <div className="modal-dialog session-picker-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>{pickerManual ? "会话库" : "恢复会话"}</h3>
            <p className="modal-subtitle">
              {pickerManual ? "选择要从库中启动的会话" : "选择要启动的会话"}
            </p>
          </div>
          <div className="modal-body">
            {pendingSessions.length === 0 ? (
              <div className="picker-empty">
                <p>没有已保存的会话</p>
              </div>
            ) : (
              <div className="picker-list">
                {pendingSessions.map((session) => {
                  const runningCount = runningCounts.get(session.id) ?? 0;
                  const isRunning = runningCount > 0;
                  const isChecked = selectedIds.has(session.id);
                  return (
                    <label
                      key={session.id}
                      className={`picker-item ${isChecked ? "checked" : ""} ${isRunning ? "running" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="picker-checkbox"
                        checked={isChecked}
                        onChange={() => {
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(session.id)) {
                              next.delete(session.id);
                            } else {
                              next.add(session.id);
                            }
                            return next;
                          });
                        }}
                      />
                      <span className="picker-item-info">
                        <span className="picker-item-title">{session.title}</span>
                        <span className={`session-type-badge ${session.type}`}>
                          {session.type === 'wsl' ? (session.wslDistro || 'WSL') : 'PS'}
                        </span>
                        {isRunning && (
                          <span className="picker-running-badge">运行中 {runningCount}</span>
                        )}
                      </span>
                      <span
                        className="picker-delete-btn"
                        title="从库中删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          handleDeleteFromLibrary(session.id);
                        }}
                      >
                        {"×"}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          <div className="modal-footer">
            {!pickerManual && (
              <button
                className="modal-button"
                type="button"
                onClick={handleStartFresh}
              >
                重新开始
              </button>
            )}
            <button
              className="modal-button"
              type="button"
              onClick={() => { setPendingSessions(null); setPickerManual(false); }}
            >
              {pickerManual ? "关闭" : "取消"}
            </button>
            <button
              className="modal-button primary"
              type="button"
              onClick={handleLaunchSelected}
              disabled={newCount === 0}
            >
              启动所选 ({newCount})
            </button>
          </div>
        </div>
      </div>
      );
    })()}
    </>
  );
}
