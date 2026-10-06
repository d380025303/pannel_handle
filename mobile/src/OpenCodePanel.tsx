import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { CodexSessionCapabilities, CodexVersionApi } from "../../src/vite-env";
import { createImeInputGuard } from "../../src/utils/terminalInput";
import { CodexVersionControl } from "../../src/components/agents/CodexVersionControl";
import type { useGraphicalSession } from "./useGraphicalSession";
import "./opencode.css";

type Controller = ReturnType<typeof useGraphicalSession>;
const authLabels = { idle: "选择登录方式后开始", running: "请在终端中完成登录", reconnecting: "登录已完成，正在重新连接…", succeeded: "登录完成，已重新连接原会话", failed: "登录未完成，可以重试", cancelled: "登录已取消" };

export function OpenCodePanel({ controller }: { controller: Controller }) {
  const sheet = controller.activeSheet;
  if (!controller.snapshot?.openCodeMobile) return <p>更新桌面宿主后可使用完整 OpenCode 功能。</p>;
  return <div className="opencode-mobile-panel">{sheet === "opencode-auth" ? <OpenCodeLogin controller={controller} />
    : sheet === "opencode-capabilities" ? <OpenCodeCapabilities controller={controller} />
      : sheet === "opencode-version" ? <OpenCodeVersion controller={controller} /> : <OpenCodeRevert controller={controller} />}</div>;
}

function OpenCodeVersion({ controller }: { controller: Controller }) {
  const latest = useRef(controller); latest.current = controller;
  const api = useRef<CodexVersionApi>({ check: (_id, force) => latest.current.openCodeRequest("version", { force }), update: () => latest.current.openCodeRequest("version-update") });
  return <CodexVersionControl sessionId={controller.session.id} provider="opencode" api={api.current} />;
}

function OpenCodeCapabilities({ controller }: { controller: Controller }) {
  const [value, setValue] = useState<CodexSessionCapabilities | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true), sequence = useRef(0);
  const tab = controller.capabilityTab === "mcp" ? "mcp" : "skills";
  const matches = (text: string) => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  async function load(refresh = false) {
    const request = ++sequence.current; setLoading(true); setError("");
    try { const next = await controller.openCodeRequest<CodexSessionCapabilities>("capabilities", { refresh }); if (mounted.current && request === sequence.current) setValue(next); }
    catch (cause) { if (mounted.current && request === sequence.current) { setValue(null); setError(String(cause)); } }
    finally { if (mounted.current && request === sequence.current) setLoading(false); }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, []);
  const skills = value?.skills.filter(skill => matches(`${skill.name} ${skill.description}`)) || [];
  const servers = value?.mcp.filter(server => matches(`${server.name} ${server.tools.map(tool => `${tool.name} ${tool.description}`).join(" ")}`)) || [];
  return <div className="graphical-sheet-list">
    <p>当前会话可用项 · 选择后填入提示，发送后由 OpenCode 使用。</p>
    <div role="tablist" aria-label="能力类型">{(["skills", "mcp"] as const).map(key => <button key={key} role="tab" aria-selected={tab === key} onClick={() => { controller.setCapabilityTab(key); setQuery(""); }}>{key === "skills" ? "Skills" : "MCP"}</button>)}</div>
    <input aria-label="搜索会话能力" placeholder="搜索名称或描述" value={query} onChange={event => setQuery(event.target.value)} />
    <button disabled={loading} onClick={() => void load(true)}>刷新</button>
    {loading && <p role="status">正在加载…</p>}{(error || value?.errors[tab]) && <p role="alert">{error || value?.errors[tab]}</p>}
    {!loading && tab === "skills" && skills.map(skill => <button key={skill.id || skill.path || skill.name} disabled={!skill.enabled} onClick={() => controller.insertReference(`请使用 skill 工具加载 ${skill.id || skill.name}`)}><span>{skill.name}<small>{skill.description || skill.scope}</small></span>{!skill.enabled && <small>已停用</small>}</button>)}
    {!loading && tab === "mcp" && servers.map(server => <section className="graphical-card" key={server.name}><strong>{server.name} · {server.status}</strong>{(server.toolsError || server.error) && <p role="alert">{server.toolsError || server.error}</p>}{server.tools.filter(tool => matches(`${server.name} ${tool.name} ${tool.description}`)).map(tool => <button key={tool.name} disabled={server.status !== "connected"} onClick={() => controller.insertReference(`请使用 MCP 工具 ${tool.name}`)}><span>{tool.name}<small>{tool.description}</small></span></button>)}</section>)}
    {!loading && value && !value.errors[tab] && !(tab === "skills" ? skills.length : servers.length) && <p>没有匹配的能力。</p>}
  </div>;
}

function OpenCodeRevert({ controller }: { controller: Controller }) {
  const snapshot = controller.snapshot!;
  const messages = snapshot.items.filter(item => item.type === "userMessage" && item.rewindMessageId);
  const [target, setTarget] = useState(controller.openCodeRevertTarget || messages.at(-1)?.rewindMessageId || "");
  const [confirming, setConfirming] = useState(false);
  const blocked = ["running", "reconnecting"].includes(snapshot.acpAuth?.status || "") || controller.codexPending || controller.isSending || snapshot.busy || snapshot.archived || !!snapshot.pendingPlan || !!snapshot.approvals.length || !!snapshot.questions.length;
  const run = async (restore = false) => {
    try { await controller.openCodeRequest(restore ? "restore" : "revert", restore ? {} : { messageId: target }); controller.setOpenCodeRevertTarget(null); controller.setActiveSheet(null); }
    catch (cause) { controller.setError(String(cause)); }
  };
  return <div className="graphical-sheet-list">
    {snapshot.historyActionsError && <p role="alert">{snapshot.historyActionsError}</p>}
    {snapshot.openCodeRevert && <><p>当前对话已回退，发送新消息会提交该回退。</p><button disabled={blocked} onClick={() => void run(true)}>恢复回退</button></>}
    <label>回退到消息<select aria-label="回退到消息" disabled={blocked || confirming} value={target} onChange={event => setTarget(event.target.value)}>{messages.map((item, index) => <option key={item.id} value={item.rewindMessageId}>第 {index + 1} 条 · {(item.text || "附件消息").slice(0, 80)}</option>)}</select></label>
    {confirming ? <><p>回退会撤销此消息及之后的对话与文件修改，回退后可恢复。</p><button disabled={blocked} onClick={() => void run()}>确认回退</button><button disabled={blocked} onClick={() => setConfirming(false)}>返回</button></> : <button disabled={blocked || !target || !snapshot.capabilities?.revertHistory} onClick={() => setConfirming(true)}>回退对话与文件</button>}
  </div>;
}

function OpenCodeLogin({ controller }: { controller: Controller }) {
  const latest = useRef(controller); latest.current = controller;
  const host = useRef<HTMLDivElement>(null), terminal = useRef<Terminal | null>(null);
  const generation = useRef(0), seq = useRef(0), mounted = useRef(false), startingRef = useRef(false);
  const fitTerminal = useRef<(() => void) | null>(null);
  const pending = useRef<Array<{ generation: number; seq: number; data: string }>>([]);
  const [method, setMethod] = useState(controller.snapshot?.acpAuth?.methods[0]?.id || "");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const auth = controller.snapshot?.acpAuth;
  const busy = starting || auth?.status === "running" || auth?.status === "reconnecting";
  const write = (data: string) => { if (generation.current) void latest.current.openCodeRequest("auth-write", { generation: generation.current, data }).catch(cause => { if (mounted.current) setError(String(cause)); }); };
  useEffect(() => {
    mounted.current = true;
    const term = new Terminal({ cursorBlink: true, convertEol: true, fontSize: 13, theme: { background: "#171717", foreground: "#e5e5e5" } });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current!); terminal.current = term;
    const resize = () => { try { fit.fit(); if (generation.current) void latest.current.openCodeRequest("auth-resize", { generation: generation.current, cols: term.cols, rows: term.rows }).catch(() => {}); } catch { /* Hidden host. */ } };
    fitTerminal.current = resize;
    const observer = new ResizeObserver(resize); observer.observe(host.current!);
    const guard = createImeInputGuard();
    const input = term.onData(data => { if (guard.shouldForwardData(data)) write(data); });
    const textarea = term.textarea;
    const compositionStart = () => guard.handleCompositionStart(), compositionEnd = () => guard.handleCompositionEnd();
    const beforeInput = (event: Event) => guard.handleBeforeInput(event as InputEvent), afterInput = (event: Event) => guard.handleInput(event as InputEvent);
    textarea?.addEventListener("compositionstart", compositionStart); textarea?.addEventListener("compositionend", compositionEnd);
    textarea?.addEventListener("beforeinput", beforeInput); textarea?.addEventListener("input", afterInput);
    const off = controller.onGraphicalMessage(message => {
      if (message.type !== "graphical.opencode.auth-data" || message.id !== controller.session.id) return;
      if (!generation.current) { if (startingRef.current) pending.current.push(message); return; }
      if (message.generation === generation.current && message.seq > seq.current) { seq.current = message.seq; term.write(message.data); }
    });
    resize();
    return () => { mounted.current = false; off(); input.dispose(); observer.disconnect();
      textarea?.removeEventListener("compositionstart", compositionStart); textarea?.removeEventListener("compositionend", compositionEnd);
      textarea?.removeEventListener("beforeinput", beforeInput); textarea?.removeEventListener("input", afterInput);
      term.dispose(); terminal.current = null; fitTerminal.current = null; if (generation.current) void latest.current.openCodeRequest("auth-cancel", { generation: generation.current }).catch(() => {}); };
  }, []);
  async function start() {
    if (busy || startingRef.current || !method) return;
    startingRef.current = true; setStarting(true); setError(""); generation.current = 0; seq.current = 0; pending.current = []; terminal.current?.reset();
    try {
      const result = await controller.openCodeRequest<{ generation: number; seq: number; history: string }>("auth-start", { methodId: method });
      if (!mounted.current) { await controller.openCodeRequest("auth-cancel", { generation: result.generation }); return; }
      generation.current = result.generation; seq.current = result.seq; terminal.current?.write(result.history);
      for (const payload of pending.current.sort((a, b) => a.seq - b.seq)) if (payload.generation === generation.current && payload.seq > seq.current) { seq.current = payload.seq; terminal.current?.write(payload.data); }
      pending.current = []; fitTerminal.current?.(); terminal.current?.focus();
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { startingRef.current = false; if (mounted.current) setStarting(false); }
  }
  return <div className="graphical-sheet-list">
    {!auth?.methods.length ? <p>当前 OpenCode 未提供终端登录方式。请在对应环境执行 opencode auth login，完成后重新连接。</p> : <><label>登录方式<select aria-label="登录方式" value={method} disabled={busy} onChange={event => setMethod(event.target.value)}>{auth.methods.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><p>{auth.methods.find(item => item.id === method)?.description}</p></>}
    <p role="status">{starting ? "正在启动登录…" : authLabels[auth?.status || "idle"]}</p>
    <div className="opencode-mobile-terminal" ref={host} />
    <div className="graphical-actions">{[["↑", "\x1b[A"], ["↓", "\x1b[B"], ["Tab", "\t"], ["Enter", "\r"]].map(([label, data]) => <button key={label} disabled={auth?.status !== "running" || !generation.current} onClick={() => write(data)}>{label}</button>)}</div>
    {(error || auth?.error) && <p role="alert">{error || auth?.error}</p>}
    <button disabled={busy || !method || controller.codexPending} onClick={() => void start()}>开始登录</button>
    <button onClick={() => controller.setActiveSheet(null)}>{busy ? "取消登录" : "关闭"}</button>
  </div>;
}
