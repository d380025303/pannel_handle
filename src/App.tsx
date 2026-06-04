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
  const [renamingId, setRenamingId] = useState<string | undefined>();
  const [renameText, setRenameText] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [commandInput, setCommandInput] = useState("");
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalsRef = useRef(new Map<string, TerminalEntry>());

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeId),
    [activeId, sessions]
  );

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
    const session = await window.terminalApi.createSession(
      initialCommand ? { initialCommand } : undefined
    );
    setActiveId(session.id);
  }

  async function handleCloseSession(id: string) {
    await window.terminalApi.closeSession(id);
    const entry = terminalsRef.current.get(id);
    if (entry) {
      entry.terminal.dispose();
      terminalsRef.current.delete(id);
    }
  }

  async function submitRename(id: string) {
    await window.terminalApi.renameSession(id, renameText);
    setRenamingId(undefined);
    setRenameText("");
  }

  return (
    <>
      <main className="app-shell">
        <aside className="session-sidebar">
          <div className="sidebar-header">
            <div>
              <h1>命令会话</h1>
              <span>{sessions.length} 个窗口</span>
            </div>
            <button className="icon-button primary" type="button" title="新建会话" onClick={() => setShowModal(true)}>
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
                  {renamingId === session.id ? (
                    <input
                      autoFocus
                      className="rename-input"
                      value={renameText}
                      onChange={(event) => setRenameText(event.target.value)}
                      onBlur={() => submitRename(session.id)}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          submitRename(session.id);
                        }
                        if (event.key === "Escape") {
                          setRenamingId(undefined);
                          setRenameText("");
                        }
                      }}
                    />
                  ) : (
                    <span className="session-title">{session.title}</span>
                  )}
                  <span className="session-path">{session.cwd}</span>
                </span>
                <span className="session-actions">
                  <span
                    className="mini-action"
                    title="重命名"
                    onClick={(event) => {
                      event.stopPropagation();
                      setRenamingId(session.id);
                      setRenameText(session.title);
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
              <span>{activeSession?.shell || "没有正在运行的命令窗口"}</span>
            </div>
          </header>
          <div className="terminal-host" ref={terminalHostRef} />
        </section>
      </main>

    {showModal && (
      <div className="modal-overlay" onClick={() => { setShowModal(false); setCommandInput(""); }}>
        <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>新建会话</h3>
          </div>
          <div className="modal-body">
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
    </>
  );
}
