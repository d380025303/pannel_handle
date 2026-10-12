import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Action = { label: string; disabled?: boolean; danger?: boolean; run: () => void };

export function WorkItemMenu({ name, actions }: { name: string; actions: Action[] }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  function close() { setOpen(false); trigger.current?.focus(); }
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const popup = menu.current?.getBoundingClientRect();
      if (!anchor || !popup) return;
      setPosition({ left: Math.max(8, Math.min(anchor.right - popup.width, window.innerWidth - popup.width - 8)),
        top: Math.max(8, anchor.bottom + popup.height + 8 <= window.innerHeight ? anchor.bottom + 4 : anchor.top - popup.height - 4) });
    };
    update();
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", update);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [open]);
  return <>
    <button ref={trigger} type="button" aria-label={`${name}：更多操作`} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(value => !value)} onKeyDown={event => {
        if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); }
      }}>更多</button>
    {open && createPortal(<div ref={menu} className="work-items-menu" role="menu" aria-label={`${name}的操作`}
      style={position} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); close(); return; }
        if (event.key === "Tab") { event.preventDefault(); close(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>{actions.map(action => <button key={action.label} role="menuitem" type="button" disabled={action.disabled}
        className={action.danger ? "work-items-menu-danger" : undefined} onClick={() => { close(); action.run(); }}>{action.label}</button>)}</div>, document.body)}
  </>;
}
