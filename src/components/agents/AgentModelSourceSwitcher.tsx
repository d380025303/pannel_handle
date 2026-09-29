import { useEffect, useState } from "react";
import { LoaderCircle, SlidersHorizontal, X } from "lucide-react";
import type { AgentModelSource, TerminalSession } from "../../vite-env";

const SOURCES: Array<{ id: AgentModelSource; label: string }> = [
  { id: "native", label: "原生模型" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "nararouter", label: "NaraRouter" },
  { id: "minimax", label: "MiniMax" }
];

export function AgentModelSourceSwitcher({ session, onSwitch }: {
  session?: TerminalSession;
  onSwitch: (id: string, source: AgentModelSource) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setOpen(false); setError(""); }, [session?.id]);
  if (session?.agentProvider === "codebuddy" && session.runtimeMode === "app-server") return null;
  if (!session || session.type === "ssh" || (session.agentProvider !== "opencode" && session.agentProvider !== "codebuddy")) return null;
  const current = session.modelSource || "native";
  const tooltip = `切换模型来源：${busy ? "正在切换" : SOURCES.find(item => item.id === current)?.label || "原生模型"}`;
  const choose = async (source: AgentModelSource) => {
    setOpen(false);
    setBusy(true);
    setError("");
    try { await onSwitch(session.id, source); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="agent-switcher">
    <button className="agent-switcher-trigger" type="button" title={tooltip} disabled={busy} aria-label="切换模型来源" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <SlidersHorizontal aria-hidden="true" />}
    </button>
    {open && <div className="agent-switcher-menu" role="menu" aria-label="模型来源">
      <small>切换将重启 Agent，并重新建立对话上下文。</small>
      {SOURCES.filter(item => item.id !== current).map(item => <button key={item.id} type="button" role="menuitem" onClick={() => void choose(item.id)}>{item.label}</button>)}
    </div>}
    {error && <div className="agent-switcher-error" role="alert"><span>{error}</span><button type="button" aria-label="关闭" onClick={() => setError("")}><X aria-hidden="true" /></button></div>}
  </div>;
}
