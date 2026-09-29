import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { CodexWorkspaceTrustRequest } from "../../vite-env";

export function CodexWorkspaceTrustDialog() {
  const [requests, setRequests] = useState<CodexWorkspaceTrustRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const current = requests[0];

  useEffect(() => {
    let disposed = false;
    const resolvedIds = new Set<string>();
    const removeChanged = window.codexWorkspaceTrustApi.onChanged(request => {
      if (disposed || resolvedIds.has(request.id)) return;
      setRequests(items => [...items.filter(item => item.id !== request.id), request]);
    });
    const removeResolved = window.codexWorkspaceTrustApi.onResolved(({ id }) => {
      resolvedIds.add(id);
      if (!disposed) setRequests(items => items.filter(item => item.id !== id));
    });
    void window.codexWorkspaceTrustApi.listPending().then(items => {
      if (!disposed) setRequests(currentItems => {
        const listed = items.filter(item => !resolvedIds.has(item.id));
        return [...listed, ...currentItems.filter(item => !resolvedIds.has(item.id) && !listed.some(entry => entry.id === item.id))];
      });
    }).catch(cause => { if (!disposed) setError(String(cause)); });
    return () => { disposed = true; removeChanged(); removeResolved(); };
  }, []);

  useEffect(() => {
    if (!current || current.phase !== "hooks" || !hostRef.current) return;
    const terminal = new Terminal({ cursorBlink: true, convertEol: true, scrollback: 3000, fontSize: 13,
      theme: { background: "#12151d", foreground: "#e6eaf2" } });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    fit.fit();
    terminal.write(current.output);
    const input = terminal.onData(data => { void window.codexWorkspaceTrustApi.write(current.id, data).catch(setError); });
    const removeOutput = window.codexWorkspaceTrustApi.onOutput(value => {
      if (value.id === current.id) terminal.write(value.data);
    });
    const observer = new ResizeObserver(() => {
      fit.fit();
      void window.codexWorkspaceTrustApi.resize(current.id, terminal.cols, terminal.rows).catch(() => {});
    });
    observer.observe(hostRef.current);
    terminalRef.current = terminal;
    return () => { observer.disconnect(); removeOutput(); input.dispose(); terminal.dispose(); terminalRef.current = null; };
  }, [current?.id, current?.phase]);

  useEffect(() => {
    if (current?.terminalOpen) terminalRef.current?.focus();
  }, [current?.id, current?.terminalOpen]);

  if (!current) return null;
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  return <div className="codex-trust-overlay" role="presentation">
    <section className="codex-trust-dialog" role="dialog" aria-modal="true" aria-labelledby="codex-trust-title">
      <header>
        <h2 id="codex-trust-title">Codex 工作区信任</h2>
        <span>{current.title || current.sessionId}</span>
      </header>
      <p>本机 Agent 将在以下临时工作区运行。请核对路径与 Hook 内容后继续。</p>
      <code className="codex-trust-path">{current.workspacePath}</code>
      {!current.ready && <p role="status">正在读取 Hook 内容…</p>}
      {current.ready && <><details><summary>查看 Hook 配置</summary><pre>{current.configPreview}</pre></details>
      <details><summary>查看 Hook 脚本</summary><pre>{current.scriptPreview}</pre></details></>}
      {current.phase === "project" ? <p>信任只应用于这个工作区；关闭会话后，应用新增的项目配置会清理。</p> : <>
        <p>打开 Codex 后，先完成可能出现的启动提示，再点击“发送 /hooks”审核并信任 Hook。完成后点击“检查并启动”。</p>
        <div ref={hostRef} className="codex-trust-terminal" aria-label="Codex Hook 审核终端" />
      </>}
      {(error || current.error) && <p className="codex-trust-error" role="alert">{error || current.error}</p>}
      <footer>
        <button type="button" disabled={busy} onClick={() => void perform(() => window.codexWorkspaceTrustApi.cancel(current.id))}>取消启动</button>
        {current.phase === "project" ?
          <button type="button" className="primary" disabled={busy || !current.ready} onClick={() => void perform(() => window.codexWorkspaceTrustApi.trustProject(current.id))}>信任当前工作区</button> : <>
            <button type="button" disabled={busy} onClick={() => void perform(() => window.codexWorkspaceTrustApi.openHooks(current.id))}>{current.terminalOpen ? "发送 /hooks" : "打开 Codex"}</button>
            <button type="button" className="primary" disabled={busy} onClick={() => void perform(() => window.codexWorkspaceTrustApi.finish(current.id))}>检查并启动</button>
          </>}
      </footer>
    </section>
  </div>;
}
