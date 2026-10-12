import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

export function OwnerCell({ label, text, code = false }: { label: string; text: string; code?: boolean }) {
  const content = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  const [overflow, setOverflow] = useState(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const cancelClose = () => { if (timer.current) clearTimeout(timer.current); };
  const closeSoon = () => { cancelClose(); timer.current = setTimeout(() => setOpen(false), 150); };

  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  useLayoutEffect(() => {
    if (!open || !button.current || !popup.current) return;
    const anchor = button.current.getBoundingClientRect();
    const bounds = popup.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8)),
      top: anchor.bottom + bounds.height + 8 <= window.innerHeight ? anchor.bottom + 8 : Math.max(8, anchor.top - bounds.height - 8),
    });
  }, [open, text]);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => { if (!popup.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    const outside = (event: MouseEvent) => { if (!button.current?.contains(event.target as Node)) close(event); };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  useEffect(() => () => cancelClose(), []);

  return <div className="module-owners-cell">
    <span ref={content} className={`module-owners-cell-text${code ? " module-owners-cell-code" : ""}`}>{text || "—"}</span>
    {overflow && <button ref={button} type="button" className="module-owners-cell-info" aria-label={`查看${label}详情`} aria-expanded={open} aria-controls={open ? id : undefined}
      onMouseEnter={() => { cancelClose(); setOpen(true); }} onMouseLeave={closeSoon}
      onFocus={() => { cancelClose(); setOpen(true); }} onBlur={event => { if (!popup.current?.contains(event.relatedTarget)) closeSoon(); }}
      onClick={() => { cancelClose(); setOpen(true); }}><Info size={16} /></button>}
    {open && overflow && createPortal(<div ref={popup} id={id} role="dialog" aria-label={`${label}详情`} tabIndex={0}
      className="module-owners-cell-popup" style={position} onMouseEnter={cancelClose} onMouseLeave={closeSoon} onFocus={cancelClose}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== button.current) closeSoon(); }}>
      <strong>{label}</strong><div className={code ? "module-owners-cell-code" : undefined}>{text}</div>
    </div>, document.body)}
  </div>;
}
