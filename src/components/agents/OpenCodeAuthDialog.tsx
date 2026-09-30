import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { CodexAppServerSnapshot, OpenCodeAuthState } from "../../vite-env";
import { createImeInputGuard } from "../../utils/terminalInput";

type Props = { sessionId: string; auth: CodexAppServerSnapshot["acpAuth"]; onClose: () => void };
const labels: Record<OpenCodeAuthState["status"], string> = {
  idle: "选择登录方式后开始", running: "请在终端中完成登录", reconnecting: "登录已完成，正在重新连接…",
  succeeded: "登录完成，已重新连接原会话", failed: "登录未完成，可以重试", cancelled: "登录已取消"
};

export function OpenCodeAuthDialog({ sessionId, auth, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const generationRef = useRef(0);
  const loginGenerationRef = useRef(0);
  const seqRef = useRef(0);
  const pendingRef = useRef<Array<{ generation: number; seq: number; data: string }>>([]);
  const mountedRef = useRef(false);
  const startingRef = useRef(false);
  const [methodId, setMethodId] = useState(auth?.methods[0]?.id || "");
  const [state, setState] = useState<OpenCodeAuthState>({ status: "idle", generation: 0, error: null });
  const [starting, setStarting] = useState(false);
  const busy = starting || state.status === "running" || state.status === "reconnecting";

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    mountedRef.current = true;
    const terminal = new Terminal({ cursorBlink: true, convertEol: true,
      fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 13, theme: { background: "#171717", foreground: "#e5e5e5" } });
    const fitAddon = new FitAddon();
    const guard = createImeInputGuard();
    terminal.loadAddon(fitAddon); terminal.open(host); terminalRef.current = terminal;
    const fit = () => {
      try {
        fitAddon.fit();
        if (generationRef.current) window.openCodeAuthApi.resize(sessionId, generationRef.current, terminal.cols, terminal.rows);
      } catch { /* Closing host. */ }
    };
    fitRef.current = fit;
    const observer = new ResizeObserver(fit); observer.observe(host);
    const offData = window.openCodeAuthApi.onData(payload => {
      if (payload.id !== sessionId) return;
      if (!generationRef.current) { pendingRef.current.push(payload); return; }
      if (payload.generation === generationRef.current && payload.seq > seqRef.current) {
        seqRef.current = payload.seq; terminal.write(payload.data);
      }
    });
    const offState = window.openCodeAuthApi.onState(payload => {
      if (payload.id !== sessionId || generationRef.current && payload.generation !== generationRef.current) return;
      loginGenerationRef.current = payload.generation;
      setState(payload);
    });
    const input = terminal.onData(data => {
      if (generationRef.current && guard.shouldForwardData(data)) window.openCodeAuthApi.write(sessionId, generationRef.current, data);
    });
    const textarea = terminal.textarea;
    const onCompositionStart = () => guard.handleCompositionStart();
    const onCompositionEnd = () => guard.handleCompositionEnd();
    const onBeforeInput = (event: Event) => guard.handleBeforeInput(event as InputEvent);
    const onInput = (event: Event) => guard.handleInput(event as InputEvent);
    const onFocus = () => guard.reset();
    const onPaste = (event: ClipboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    textarea?.addEventListener("compositionstart", onCompositionStart);
    textarea?.addEventListener("compositionend", onCompositionEnd);
    textarea?.addEventListener("beforeinput", onBeforeInput);
    textarea?.addEventListener("input", onInput);
    textarea?.addEventListener("focus", onFocus);
    textarea?.addEventListener("paste", onPaste, true);
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== "keydown" || event.isComposing) return true;
      if ((event.ctrlKey && event.key.toLowerCase() === "v") || (event.shiftKey && event.key === "Insert")) {
        const generation = generationRef.current;
        void window.clipboardApi.readText().then(text => {
          if (mountedRef.current && generation && generationRef.current === generation && text) window.openCodeAuthApi.write(sessionId, generation, text);
        }).catch(() => {});
        return false;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "c" && terminal.hasSelection()) {
        void window.clipboardApi.writeText(terminal.getSelection()).then(() => terminal.clearSelection()).catch(() => {});
        return false;
      }
      return true;
    });
    fit();
    return () => {
      mountedRef.current = false;
      if (loginGenerationRef.current) void window.openCodeAuthApi.cancel(sessionId, loginGenerationRef.current).catch(() => {});
      offData(); offState(); input.dispose(); observer.disconnect();
      textarea?.removeEventListener("compositionstart", onCompositionStart);
      textarea?.removeEventListener("compositionend", onCompositionEnd);
      textarea?.removeEventListener("beforeinput", onBeforeInput);
      textarea?.removeEventListener("input", onInput);
      textarea?.removeEventListener("focus", onFocus);
      textarea?.removeEventListener("paste", onPaste, true);
      terminal.dispose(); terminalRef.current = null; fitRef.current = null;
    };
  }, [sessionId]);

  async function start() {
    if (startingRef.current || busy || !methodId) return;
    startingRef.current = true; setStarting(true);
    generationRef.current = 0; loginGenerationRef.current = 0; seqRef.current = 0; pendingRef.current = [];
    terminalRef.current?.reset();
    setState({ status: "running", generation: 0, error: null });
    try {
      const result = await window.openCodeAuthApi.start(sessionId, methodId);
      if (!mountedRef.current) { await window.openCodeAuthApi.cancel(sessionId, result.generation); return; }
      generationRef.current = result.generation; loginGenerationRef.current = result.generation; seqRef.current = result.seq;
      terminalRef.current?.write(result.history);
      for (const payload of pendingRef.current.sort((a, b) => a.seq - b.seq)) {
        if (payload.generation === result.generation && payload.seq > seqRef.current) {
          seqRef.current = payload.seq; terminalRef.current?.write(payload.data);
        }
      }
      pendingRef.current = []; fitRef.current?.(); terminalRef.current?.focus();
    } catch (error) {
      if (mountedRef.current) setState({ status: "failed", generation: 0, error: error instanceof Error ? error.message : String(error) });
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setStarting(false);
    }
  }

  return <div className="modal-overlay" onKeyDown={event => {
    if (event.key === "Escape" && !busy) onClose();
  }}>
    <div className="modal-dialog opencode-auth-dialog" role="dialog" aria-modal="true" aria-label="登录 OpenCode">
      <h2>登录 OpenCode</h2>
      {!auth?.methods.length ? <p>当前 OpenCode 未提供终端登录方式。请在对应运行环境中执行 <code>opencode auth login</code>，完成后重新连接图形会话。</p>
        : <>
          <label>登录方式 <select aria-label="登录方式" value={methodId} disabled={busy} onChange={event => setMethodId(event.target.value)}>
            {auth.methods.map(method => <option key={method.id} value={method.id}>{method.name}</option>)}
          </select></label>
          <p>{auth.methods.find(method => method.id === methodId)?.description}</p>
          <p role="status">{labels[state.status]}</p>
          <div className="opencode-auth-terminal terminal-host" ref={hostRef} />
          {state.error && <p role="alert">{state.error}</p>}
        </>}
      <div className="modal-actions">
        {!!auth?.methods.length && <button type="button" disabled={busy} onClick={() => void start()}>{state.status === "failed" || state.status === "cancelled" ? "重试登录" : "开始登录"}</button>}
        <button type="button" onClick={onClose}>{state.status === "running" || starting ? "取消登录" : "关闭"}</button>
      </div>
    </div>
  </div>;
}
