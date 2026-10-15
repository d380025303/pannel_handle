import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { createImeInputGuard } from "../../utils/terminalInput";

type Props = { sessionId: string; visible: boolean; theme: ITheme };

export function SessionShellPanel({ sessionId, visible, theme }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [error, setError] = useState("");
  const [exited, setExited] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ownerToken = crypto.randomUUID();
    const terminal = new Terminal({
      allowTransparency: true, cursorBlink: true, convertEol: true,
      fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 13, lineHeight: 1.2,
      theme
    });
    const fitAddon = new FitAddon();
    const inputGuard = createImeInputGuard();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    let disposed = false;
    let generation = 0;
    let lastSeq = 0;
    const pending: { generation: number; seq: number; data: string }[] = [];
    const removeData = window.sessionShellApi.onData(payload => {
      if (payload.id !== sessionId) return;
      if (!generation) { pending.push(payload); return; }
      if (payload.generation === generation && payload.seq > lastSeq) {
        lastSeq = payload.seq;
        terminal.write(payload.data);
      }
    });
    const removeExit = window.sessionShellApi.onExit(payload => {
      if (payload.id === sessionId && (!generation || payload.generation === generation)) {
        terminal.writeln(`\r\n[Shell exited: ${payload.exitCode}]`);
        setExited(true);
      }
    });
    const fit = () => {
      if (!visibleRef.current || !generation) return;
      try {
        fitAddon.fit();
        window.sessionShellApi.resize(sessionId, generation, terminal.cols, terminal.rows);
      } catch { /* Hidden or closing host. */ }
    };
    fitRef.current = fit;
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    const onData = terminal.onData(data => {
      if (generation && inputGuard.shouldForwardData(data)) window.sessionShellApi.write(sessionId, generation, data);
    });
    const textarea = terminal.textarea;
    const onFocus = () => inputGuard.reset();
    const onPaste = (event: ClipboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const onCompositionStart = () => inputGuard.handleCompositionStart();
    const onCompositionEnd = () => inputGuard.handleCompositionEnd();
    const onBeforeInput = (event: Event) => inputGuard.handleBeforeInput(event as InputEvent);
    const onInput = (event: Event) => inputGuard.handleInput(event as InputEvent);
    textarea?.addEventListener("focus", onFocus);
    textarea?.addEventListener("paste", onPaste, true);
    textarea?.addEventListener("compositionstart", onCompositionStart);
    textarea?.addEventListener("compositionend", onCompositionEnd);
    textarea?.addEventListener("beforeinput", onBeforeInput);
    textarea?.addEventListener("input", onInput);
    const paste = async () => {
      if (!generation) return;
      const image = await window.clipboardApi.pasteImageToSession(sessionId);
      if (image.status === "saved") {
        window.sessionShellApi.write(sessionId, generation, image.path);
        return;
      }
      const text = await window.clipboardApi.readText();
      if (text) terminal.paste(text);
    };
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (terminal.hasSelection()) {
        void window.clipboardApi.writeText(terminal.getSelection()).then(() => terminal.clearSelection());
      } else {
        void window.clipboardApi.readText().then(text => {
          if (text && generation) terminal.paste(text);
        });
      }
    };
    host.addEventListener("contextmenu", onContextMenu);
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== "keydown" || event.isComposing) return true;
      if ((event.ctrlKey && event.key.toLowerCase() === "v") || (event.shiftKey && event.key === "Insert")) {
        void paste().catch(cause => terminal.writeln(`\r\n${cause instanceof Error ? cause.message : String(cause)}`));
        return false;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "c" && terminal.hasSelection()) {
        void window.clipboardApi.writeText(terminal.getSelection()).then(() => terminal.clearSelection());
        return false;
      }
      return true;
    });
    void window.sessionShellApi.open(sessionId, ownerToken).then(snapshot => {
      if (disposed) { void window.sessionShellApi.close(sessionId, ownerToken); return; }
      generation = snapshot.generation;
      lastSeq = snapshot.seq;
      terminal.write(snapshot.history);
      pending.sort((a, b) => a.seq - b.seq).forEach(payload => {
        if (payload.generation === generation && payload.seq > lastSeq) {
          lastSeq = payload.seq;
          terminal.write(payload.data);
        }
      });
      fit();
      if (visibleRef.current) terminal.focus();
    }).catch(cause => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      disposed = true;
      removeData();
      removeExit();
      onData.dispose();
      textarea?.removeEventListener("focus", onFocus);
      textarea?.removeEventListener("paste", onPaste, true);
      textarea?.removeEventListener("compositionstart", onCompositionStart);
      textarea?.removeEventListener("compositionend", onCompositionEnd);
      textarea?.removeEventListener("beforeinput", onBeforeInput);
      textarea?.removeEventListener("input", onInput);
      observer.disconnect();
      fitRef.current = null;
      host.removeEventListener("contextmenu", onContextMenu);
      terminal.dispose();
      terminalRef.current = null;
      void window.sessionShellApi.close(sessionId, ownerToken);
    };
  }, [sessionId, attempt]);

  useEffect(() => { if (terminalRef.current) terminalRef.current.options.theme = theme; }, [theme]);
  useEffect(() => {
    if (!visible || !terminalRef.current) return;
    const frame = requestAnimationFrame(() => {
      fitRef.current?.();
      terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  return <section className="session-shell-panel" style={{ display: visible ? undefined : "none" }} aria-hidden={!visible}>
    <div className="session-shell-host terminal-host" ref={hostRef} />
    {(error || exited) && <div className="session-shell-notice" role="alert">
      <span>{error || "Shell 已退出"}</span>
      <button type="button" onClick={() => { setError(""); setExited(false); setAttempt(value => value + 1); }}>重新打开</button>
    </div>}
  </section>;
}
