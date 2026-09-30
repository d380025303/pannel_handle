import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { CodexAppServerSnapshot } from "../../vite-env";

type ContextUsage = NonNullable<CodexAppServerSnapshot["contextUsage"]>;
const categories = [
  ["systemPrompt", "系统提示词"], ["tools", "工具"], ["conversation", "对话"],
  ["mcp", "MCP"], ["skills", "Skills"]
] as const;

export function CodeBuddyContextUsage({ usage, provider = "codebuddy" }: { usage: ContextUsage | null; provider?: "codebuddy" | "opencode" }) {
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const valid = usage && Number.isFinite(usage.used) && usage.used >= 0 && Number.isFinite(usage.size) && usage.size > 0;
  const percent = valid ? Math.max(0, Math.min(100, usage.used / usage.size * 100)) : 0;
  const format = (value: number) => new Intl.NumberFormat(locale).format(value);

  useEffect(() => { if (!valid) setOpen(false); }, [valid]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); buttonRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [open]);

  return <div className="codebuddy-context-usage" ref={rootRef}>
    <button ref={buttonRef} type="button" className="codebuddy-context-trigger" disabled={!valid}
      aria-label={valid ? `上下文用量 ${percent.toFixed(1)}%` : "等待上下文用量"}
      aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}>
      <svg className="codebuddy-context-ring" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="codebuddy-context-ring-track" cx="12" cy="12" r="9" />
        {valid && <circle className="codebuddy-context-ring-value" cx="12" cy="12" r="9"
          pathLength="100" strokeDasharray={`${percent} 100`} />}
      </svg>
      <span>{valid ? `${percent.toFixed(1)}%` : "上下文等待中"}</span>
    </button>
    {open && valid && <div className="agent-token-live-popover codebuddy-context-popover" role="dialog" aria-label={`${provider === "opencode" ? "OpenCode" : "CodeBuddy"} 上下文用量`}>
      <header><span><strong>上下文用量</strong></span><button type="button" aria-label="关闭" onClick={() => { setOpen(false); buttonRef.current?.focus(); }}><X aria-hidden="true" /></button></header>
      <div className="agent-token-live-grid">
        <span>已用 / 窗口</span><strong>{format(usage.used)} / {format(usage.size)} tokens</strong>
        <span>占用比例</span><strong>{percent.toFixed(1)}%</strong>
        {categories.filter(([key]) => Number.isFinite(usage.categories?.[key])).map(([key, label]) => <div className="codebuddy-context-category" key={key}>
          <span>{label}</span><strong>{format(usage.categories[key]!)}</strong>
        </div>)}
      </div>
    </div>}
  </div>;
}
