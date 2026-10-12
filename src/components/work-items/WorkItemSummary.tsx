import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WorkItem } from "../../vite-env";
import "../../styles/markdown-content.css";

export function WorkItemSummary({ id, version, name, summary, disabled, resetKey }: {
  id: string; version: number; name: string; summary: string; disabled: boolean; resetKey: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cache = useRef<WorkItem | null>(null);
  const openedKey = useRef("");
  const currentKey = JSON.stringify([id, version, resetKey]);
  const popupId = useId();
  const [open, setOpen] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const cancelClose = () => { if (timer.current) clearTimeout(timer.current); };
  const closeSoon = () => { cancelClose(); timer.current = setTimeout(() => setOpen(false), 150); };
  useEffect(() => { setOpen(false); }, [disabled, resetKey, id, version]);
  useEffect(() => () => cancelClose(), []);
  useEffect(() => {
    if (!open || disabled || openedKey.current !== currentKey) return;
    let live = true;
    setError("");
    if (cache.current?.id === id && cache.current.version === version) {
      setOutput(cache.current.output);
      return;
    }
    setOutput(null);
    void window.workItemApi.get({ id }).then(value => {
      if (!live) return;
      cache.current = value; setOutput(value.output);
    }).catch(err => { if (live) setError(String(err)); });
    return () => { live = false; };
  }, [open, disabled, id, version, retry, currentKey]);
  useLayoutEffect(() => {
    if (!open || disabled) return;
    const anchor = trigger.current?.getBoundingClientRect();
    const bounds = popup.current?.getBoundingClientRect();
    if (!anchor || !bounds) return;
    setPosition({ left: Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8)),
      top: anchor.bottom + bounds.height + 8 <= window.innerHeight ? anchor.bottom + 8 : Math.max(8, anchor.top - bounds.height - 8) });
  }, [open, disabled, output, error]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const outside = (event: Event) => {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const scroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
    window.addEventListener("resize", close);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const show = () => { cancelClose(); openedKey.current = currentKey; setOpen(true); };
  return <div className="work-items-summary-cell">
    <div className="work-items-summary"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{summary}</ReactMarkdown></div>
    <button ref={trigger} type="button" className="work-items-summary-info" disabled={disabled}
      aria-label={`${name}：查看完整回复`} aria-expanded={open && !disabled} aria-controls={open && !disabled ? popupId : undefined}
      onMouseEnter={show} onMouseLeave={closeSoon} onFocus={show} onClick={show}
      onBlur={event => { if (!popup.current?.contains(event.relatedTarget)) closeSoon(); }}><Info size={16} /></button>
    {open && !disabled && createPortal(<div ref={popup} id={popupId} role="dialog" aria-label={`${name}：完整回复`} tabIndex={0}
      className="work-items-summary-popup" style={position} onMouseEnter={cancelClose} onMouseLeave={closeSoon} onFocus={cancelClose}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) closeSoon(); }}>
      <strong>{name} · 原始最终回复</strong>
      {error ? <div><p role="alert">{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></div>
        : output === null ? <p role="status">正在加载完整回复…</p>
        : <div className="remote-preview-markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{output || "无回复"}</ReactMarkdown></div>}
    </div>, document.body)}
  </div>;
}
