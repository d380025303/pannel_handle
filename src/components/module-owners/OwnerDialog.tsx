import { createContext, useContext, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

const ParentDialog = createContext<React.RefObject<HTMLDivElement | null> | null>(null);

export function OwnerDialog({ title, busy, onClose, children, wide = false }: { title: string; busy: boolean; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const parent = useContext(ParentDialog);
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const background = parent?.current;
    ref.current?.focus();
    if (background) {
      background.inert = true;
      background.setAttribute("aria-hidden", "true");
      background.removeAttribute("aria-modal");
    }
    return () => {
      if (background) {
        background.inert = false;
        background.removeAttribute("aria-hidden");
        background.setAttribute("aria-modal", "true");
      }
      if (opener?.isConnected) {
        opener.focus();
        // A completed request may enable the opener later in the same commit.
        if (document.activeElement !== opener) queueMicrotask(() => {
          if (opener.isConnected && document.activeElement === document.body) opener.focus();
        });
      }
    };
  }, [parent]);
  return createPortal(<ParentDialog.Provider value={ref}>
    <div className="modal-overlay module-owners-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy && !ref.current?.inert) onClose(); }}>
      <div ref={ref} tabIndex={-1} className={`modal-dialog module-owners-dialog${wide ? " module-owners-dialog-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={event => {
        if (ref.current?.inert) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }
        if (event.key !== "Tab") return;
        event.stopPropagation();
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary')).filter(item => !item.matches(":disabled"));
        if (!items.length) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === items[0] || document.activeElement === ref.current)) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && (document.activeElement === items.at(-1) || document.activeElement === ref.current)) { event.preventDefault(); items[0]?.focus(); }
      }}>
        <header className="module-owners-dialog-header"><h2 id={titleId}>{title}</h2><button type="button" aria-label="关闭弹窗" disabled={busy} onClick={onClose}>×</button></header>
        {children}
      </div>
    </div>
  </ParentDialog.Provider>, document.body);
}
