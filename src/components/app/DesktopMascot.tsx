import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { GripHorizontal, MessageCircle, Minus, Sparkles, X } from "lucide-react";
import type { AgentRunStatus, Locale } from "../../vite-env";
import mascotImage from "../../assets/mascot/panel-navigator.png";
import "./DesktopMascot.css";

export type MascotAction = "create" | "sessions" | "terminal" | "skills" | "mcp" | "settings";
type Preferences = { collapsed: boolean; animated: boolean; x?: number; y?: number };
const storageKey = "pannel-handle.desktop-mascot.v1";

function loadPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "null");
    return {
      collapsed: value?.collapsed === true,
      animated: value?.animated !== false,
      x: typeof value?.x === "number" && Number.isFinite(value.x) ? value.x : undefined,
      y: typeof value?.y === "number" && Number.isFinite(value.y) ? value.y : undefined
    };
  } catch { return { collapsed: false, animated: true }; }
}

function boundPosition(x: number, y: number, collapsed: boolean) {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - (collapsed ? 52 : 144) - 8)),
    y: Math.max(44, Math.min(y, window.innerHeight - (collapsed ? 52 : 212) - 8))
  };
}

export function DesktopMascot({ locale, status, sessionTitle, onAction }: {
  locale: Locale;
  status?: AgentRunStatus;
  sessionTitle?: string;
  onAction: (action: MascotAction) => void;
}) {
  const zh = locale === "zh-CN";
  const [preferences, setPreferences] = useState(loadPreferences);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<{ from: "user" | "mascot"; text: string }[]>([]);
  const [greeting, setGreeting] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; startX: number; startY: number } | undefined>(undefined);
  const log = useRef<HTMLDivElement>(null);
  const position = boundPosition(preferences.x ?? viewport.width - 172, preferences.y ?? viewport.height - 250, preferences.collapsed);
  const text = (cn: string, en: string) => zh ? cn : en;
  const mood = status === "running" ? "working" : status === "waiting_for_permission" || status === "e_prompt" ? "waiting" : status === "completed" ? "happy" : status === "failed" ? "concerned" : "idle";
  const statusText = mood === "working" ? text("Agent 正在工作，我陪你一起等。", "Your agent is working. I'll keep you company.")
    : mood === "waiting" ? text("Agent 需要你的回应，请到当前会话查看。", "Your agent needs your response. Check the current session.")
    : mood === "happy" ? text("本轮任务已完成，记得查看结果哦。", "This turn is complete. Take a look at the result.")
    : mood === "concerned" ? text("本轮任务遇到问题，请查看会话中的错误。", "This turn hit a problem. Check the session for details.")
    : status === "exited" || status === "ended" ? text("Agent 已结束，可以打开会话或开始新任务。", "The agent has stopped. Open a session or start a new task.")
    : text("我是小帕，陪你管理终端、远程连接与 AI 工作流。", "I'm Panna, your terminal, SSH and AI workflow companion.");
  const actions: { id: MascotAction; label: string }[] = [
    { id: "create", label: text("新建会话", "New session") },
    { id: "sessions", label: text("切换会话", "Switch session") },
    { id: "terminal", label: text("当前工作区", "Workspace") },
    { id: "skills", label: "Skills" }, { id: "mcp", label: "MCP" },
    { id: "settings", label: text("设置", "Settings") }
  ];

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* Preferences are optional. */ }
  }, [preferences]);
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => { log.current?.scrollTo?.({ top: log.current.scrollHeight }); }, [messages, open]);
  useEffect(() => {
    if (!greeting) return;
    const timer = window.setTimeout(() => setGreeting(false), 900);
    return () => window.clearTimeout(timer);
  }, [greeting]);

  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: position.x, startY: position.y };
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.id !== event.pointerId) return;
    const next = boundPosition(drag.current.startX + event.clientX - drag.current.x, drag.current.startY + event.clientY - drag.current.y, preferences.collapsed);
    setPreferences(current => ({ ...current, ...next }));
  }
  function sendMessage() {
    const input = draft.trim();
    if (!input) return;
    let reply = text("我可以介绍项目功能。需要执行任务时，请打开工作区，在已有 Agent 会话中输入指令。", "I can explain the app. To run a task, open your workspace and give instructions to your agent.");
    if (/状态|进度|status|progress/i.test(input)) reply = statusText;
    else if (/ssh|远程|remote/i.test(input)) reply = text("点击「新建会话」选择 SSH，配置远程连接；已有连接可在「切换会话」中打开。", "Choose SSH in New session to configure a remote connection, or open an existing one with Switch session.");
    else if (/skill|技能/i.test(input)) reply = text("Skills 入口可以查看和管理技能。实际可用技能由对应 Agent 的配置决定。", "Open Skills to inspect and manage skills. Availability depends on your agent configuration.");
    else if (/mcp|工具/i.test(input)) reply = text("MCP 入口可以管理工具服务，连接能力以当前 Agent 的支持情况为准。", "Open MCP to manage tool services. Connections depend on your agent's supported capabilities.");
    else if (/你好|hello|hi\b|陪|累|谢谢|thanks/i.test(input)) reply = text("我在呢。休息一下也没关系，回来我们再继续。", "I'm here. Take a breather whenever you need; we can continue when you're ready.");
    setMessages(current => [...current, { from: "user" as const, text: input }, { from: "mascot" as const, text: reply }].slice(-20));
    setDraft("");
    setGreeting(true);
  }

  const style: CSSProperties = { left: position.x, top: position.y };
  return (
    <aside className={`desktop-mascot mood-${mood}${preferences.collapsed ? " is-collapsed" : ""}${preferences.animated ? " is-animated" : ""}${greeting ? " is-greeting" : ""}`} style={style} aria-label={text("看板娘小帕", "Panna companion")}>
      <div className="desktop-mascot-controls">
        <button type="button" className="desktop-mascot-drag" aria-label={text("拖动看板娘（方向键移动）", "Move companion (arrow keys)")} title={text("拖动位置，或使用方向键", "Drag or use arrow keys")}
          onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }} onLostPointerCapture={() => { drag.current = undefined; }}
          onKeyDown={event => {
            const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
            if (!delta) return;
            event.preventDefault();
            setPreferences(current => ({ ...current, ...boundPosition(position.x + delta[0], position.y + delta[1], current.collapsed) }));
          }}><GripHorizontal size={16} /></button>
        {!preferences.collapsed && <button type="button" aria-label={text("收起看板娘", "Minimize companion")} onClick={() => { setOpen(false); setPreferences(current => ({ ...current, collapsed: true })); }}><Minus size={14} /></button>}
      </div>
      <button type="button" className="desktop-mascot-character" aria-expanded={open} aria-controls="desktop-mascot-dialog" aria-label={preferences.collapsed ? text("展开看板娘", "Expand companion") : text("和小帕聊聊", "Talk to Panna")}
        onClick={() => { if (preferences.collapsed) setPreferences(current => ({ ...current, collapsed: false })); else setOpen(value => !value); setGreeting(true); }}>
        {preferences.collapsed ? <Sparkles size={24} /> : <img src={mascotImage} alt="" draggable={false} />}
      </button>
      {!preferences.collapsed && <span className="desktop-mascot-badge"><i aria-hidden="true" />{text("小帕", "Panna")} · {text(mood === "working" ? "工作中" : mood === "waiting" ? "等你回应" : mood === "happy" ? "已完成" : mood === "concerned" ? "遇到问题" : "陪伴中", mood)}</span>}
      {open && !preferences.collapsed && <section id="desktop-mascot-dialog" className="desktop-mascot-dialog" aria-label={text("小帕的对话与快捷操作", "Panna chat and shortcuts")}
        style={{ left: Math.max(8, Math.min(position.x - 300, viewport.width - 328)), top: Math.max(44, Math.min(position.y - 160, viewport.height - 440)) }} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>
        <header><strong><MessageCircle size={16} />{text("小帕 · 终端领航员", "Panna · Terminal navigator")}</strong><button type="button" aria-label={text("关闭对话", "Close chat")} onClick={() => setOpen(false)}><X size={16} /></button></header>
        <p className="desktop-mascot-context">{sessionTitle || text("尚未选择会话", "No active session")}</p>
        <p className="desktop-mascot-status" role="status">{statusText}</p>
        <div className="desktop-mascot-actions">{actions.map(action => <button type="button" key={action.id} onClick={() => { setOpen(false); onAction(action.id); }}>{action.label}</button>)}</div>
        <div className="desktop-mascot-log" ref={log} role="log" aria-label={text("对话记录", "Chat history")} aria-live="polite">{messages.map((message, index) => <p className={`from-${message.from}`} key={index}><b>{message.from === "user" ? text("你", "You") : text("小帕", "Panna")}</b>{message.text}</p>)}</div>
        <form onSubmit={event => { event.preventDefault(); sendMessage(); }}><input aria-label={text("给小帕留言", "Message Panna")} placeholder={text("试试：状态、SSH、Skills…", "Try: status, SSH, Skills…")} maxLength={500} value={draft} onChange={event => setDraft(event.target.value)} /><button type="submit" disabled={!draft.trim()}>{text("发送", "Send")}</button></form>
        <footer><span>{text("本地提示对话 · 不执行命令", "Local guidance · no command execution")}</span><button type="button" onClick={() => setPreferences(current => ({ ...current, animated: !current.animated }))}>{preferences.animated ? text("暂停动画", "Pause motion") : text("开启动画", "Enable motion")}</button><button type="button" onClick={() => setPreferences(current => ({ ...current, x: undefined, y: undefined }))}>{text("归位", "Reset position")}</button></footer>
      </section>}
    </aside>
  );
}
