import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { applyTerminalModifiers, createRequestId } from "./protocol";
import { createTerminalTouchScroller } from "./terminalTouchScroll";
import { QuickCommandPicker } from "./QuickCommandPicker";
import { PROTOCOL_VERSION, type ClientMessage, type QuickCommand, type RuntimeSession, type ServerMessage } from "./types";

type TerminalMessage = Extract<ServerMessage,
  { type: "terminal.snapshot" | "terminal.data" | "terminal.exit" | "terminal.size-owner" }>;

type TerminalViewProps = {
  session: RuntimeSession;
  deviceId?: string;
  connectionEpoch: number;
  send: (message: ClientMessage) => boolean;
  onTerminalMessage: (listener: (message: TerminalMessage) => void) => () => void;
  pasteText: string;
  setPasteText: Dispatch<SetStateAction<string>>;
  pasteOpen: boolean;
  setPasteOpen: (open: boolean) => void;
};

const KEYS = [
  ["Esc", "\x1b"], ["Tab", "\t"], ["↑", "\x1b[A"], ["↓", "\x1b[B"],
  ["←", "\x1b[D"], ["→", "\x1b[C"], ["Home", "\x1b[H"], ["End", "\x1b[F"],
  ["Pg↑", "\x1b[5~"], ["Pg↓", "\x1b[6~"], ["Enter", "\r"], ["⌫", "\x7f"]
] as const;

export function TerminalView({ session, deviceId, connectionEpoch, send, onTerminalMessage, pasteText, setPasteText, pasteOpen, setPasteOpen }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const seqRef = useRef(new Map<string, number>());
  const ownerRef = useRef<string>("desktop");
  const ctrlRef = useRef(false);
  const altRef = useRef(false);
  const [owner, setOwner] = useState("desktop");
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [copyText, setCopyText] = useState<string | null>(null);
  const [quickError, setQuickError] = useState("");
  const [pasteError, setPasteError] = useState("");

  useEffect(() => { ctrlRef.current = ctrl; }, [ctrl]);
  useEffect(() => { altRef.current = alt; }, [alt]);

  const sendInput = useCallback((data: string) => {
    const modified = applyTerminalModifiers(data, ctrlRef.current, altRef.current);
    const sent = send({ v: PROTOCOL_VERSION, type: "terminal.input", sessionId: session.id, data: modified });
    if (sent && ctrlRef.current) setCtrl(false);
    if (sent && altRef.current) setAlt(false);
    return sent;
  }, [send, session.id]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      fontFamily: "Cascadia Mono, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: "#080d16",
        foreground: "#d8e2f0",
        cursor: "#67e8f9",
        selectionBackground: "#264d69"
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    const touchScroller = createTerminalTouchScroller({
      getLineHeight: () => {
        const screenHeight = terminal.element?.querySelector<HTMLElement>(".xterm-screen")?.getBoundingClientRect().height;
        return (screenHeight || container.clientHeight) / terminal.rows;
      },
      scrollLines: (lines) => terminal.scrollLines(lines)
    });
    const handleTouchStart = (event: TouchEvent) => touchScroller.start(event.touches);
    const handleTouchMove = (event: TouchEvent) => {
      if (touchScroller.move(event.touches) && event.cancelable) event.preventDefault();
    };
    const handleTouchEnd = () => touchScroller.end();
    terminal.element?.addEventListener("touchstart", handleTouchStart, { passive: true });
    terminal.element?.addEventListener("touchmove", handleTouchMove, { passive: false });
    terminal.element?.addEventListener("touchend", handleTouchEnd, { passive: true });
    terminal.element?.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    const inputDisposable = terminal.onData(sendInput);
    const unsubscribe = onTerminalMessage((message) => {
      if (message.type === "terminal.snapshot" && message.snapshot.sessionId === session.id) {
        ownerRef.current = message.snapshot.owner;
        setOwner(message.snapshot.owner);
        terminal.reset();
        terminal.resize(message.snapshot.cols, message.snapshot.rows);
        terminal.write(message.snapshot.ansi);
        seqRef.current.set(session.id, message.snapshot.seq);
      } else if (message.type === "terminal.data" && message.sessionId === session.id) {
        const last = seqRef.current.get(session.id) ?? 0;
        if (message.seq > last) {
          terminal.write(message.data);
          seqRef.current.set(session.id, message.seq);
        }
      } else if (message.type === "terminal.size-owner" && message.sessionId === session.id) {
        ownerRef.current = message.owner;
        setOwner(message.owner);
        terminal.resize(message.cols, message.rows);
      } else if (message.type === "terminal.exit" && message.sessionId === session.id) {
        terminal.write("\r\n\x1b[33m[会话已结束]\x1b[0m\r\n");
      }
    });
    terminal.focus();
    return () => {
      terminal.element?.removeEventListener("touchstart", handleTouchStart);
      terminal.element?.removeEventListener("touchmove", handleTouchMove);
      terminal.element?.removeEventListener("touchend", handleTouchEnd);
      terminal.element?.removeEventListener("touchcancel", handleTouchEnd);
      unsubscribe();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [onTerminalMessage, send, sendInput, session.id]);

  useEffect(() => {
    if (!connectionEpoch) return;
    send({ v: PROTOCOL_VERSION, type: "terminal.subscribe", sessionId: session.id,
      lastSeq: seqRef.current.get(session.id) });
  }, [connectionEpoch, send, session.id]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !deviceId) return;
    const observer = new ResizeObserver(() => {
      if (ownerRef.current !== deviceId) return;
      const dimensions = fitRef.current?.proposeDimensions();
      if (!dimensions) return;
      send({
        v: PROTOCOL_VERSION,
        type: "terminal.resize",
        sessionId: session.id,
        cols: Math.max(20, dimensions.cols),
        rows: Math.max(5, dimensions.rows)
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [deviceId, send, session.id]);

  const claimSize = () => {
    const dimensions = fitRef.current?.proposeDimensions();
    if (!dimensions) return;
    send({
      v: PROTOCOL_VERSION,
      type: "terminal.claim-size",
      sessionId: session.id,
      cols: Math.max(20, dimensions.cols),
      rows: Math.max(5, dimensions.rows)
    });
  };

  const copySelection = () => {
    const value = terminalRef.current?.getSelection() ?? "";
    setCopyText(value || "请先在终端中选择文本");
  };
  const runQuickCommand = (command: QuickCommand) => {
    const sent = send({ v: PROTOCOL_VERSION, type: "quick-command.invoke",
      sessionId: session.id, commandId: command.id, requestId: createRequestId() });
    setQuickError(sent ? "" : "连接已断开，请重试。");
    return sent;
  };

  return (
    <section className="terminal-shell">
      <header className="terminal-header">
        <div>
          <strong>{session.title}</strong>
          <span>{session.type.toUpperCase()}</span>
        </div>
        <button type="button" className={owner === deviceId ? "owner-button active" : "owner-button"} onClick={claimSize}>
          {owner === deviceId ? "手机尺寸" : "适配本机"}
        </button>
      </header>
      <div className="terminal-scroll"><div className="terminal-host" ref={containerRef} /></div>
      {quickError && <div className="command-error" role="alert">{quickError}</div>}
      <QuickCommandPicker commands={session.quickCommands || []} onSelect={runQuickCommand} />
      <div className="terminal-toolbar" aria-label="终端专用按键">
        <button className={ctrl ? "latched" : ""} type="button" aria-pressed={ctrl} onClick={() => setCtrl((value) => !value)}>Ctrl</button>
        <button className={alt ? "latched" : ""} type="button" aria-pressed={alt} onClick={() => setAlt((value) => !value)}>Alt</button>
        {KEYS.map(([label, value]) => <button key={label} type="button" onClick={() => sendInput(value)}>{label}</button>)}
        <button type="button" onClick={() => { setPasteError(""); setPasteOpen(true); }}>粘贴</button>
        <button type="button" onClick={copySelection}>复制</button>
      </div>
      {pasteOpen && (
        <div className="sheet-backdrop">
          <form className="text-sheet" onSubmit={(event) => {
            event.preventDefault();
            if (pasteText && !sendInput(pasteText)) { setPasteError("连接已断开，请重试。"); return; }
            setPasteError(""); setPasteText(""); setPasteOpen(false);
          }}>
            <h3>粘贴到终端</h3>
            <p>请长按下方文本框，使用系统或输入法剪贴板粘贴。</p>
            {pasteError && <p role="alert">{pasteError}</p>}
            <textarea aria-label="粘贴到终端的文本" autoFocus value={pasteText} onChange={(event) => setPasteText(event.target.value)} />
            <div><button type="button" onClick={() => setPasteOpen(false)}>取消</button><button type="submit" className="primary">发送</button></div>
          </form>
        </div>
      )}
      {copyText !== null && (
        <div className="sheet-backdrop">
          <div className="text-sheet">
            <h3>复制终端文本</h3>
            <p>长按文本并使用系统复制。</p>
            <textarea aria-label="复制终端文本" readOnly value={copyText} onFocus={(event) => event.currentTarget.select()} />
            <div><button type="button" className="primary" onClick={() => setCopyText(null)}>完成</button></div>
          </div>
        </div>
      )}
    </section>
  );
}
