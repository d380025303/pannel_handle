import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { useI18n } from "../../i18n";
import { GraphicalMenuSettings } from "./GraphicalMenuSettings";

export function GraphicalMenuSettingsDialog({ initialProvider, onClose }: { initialProvider: string; onClose: () => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const close = () => { if (!busyRef.current) onClose(); };
  useEffect(() => { dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, []);
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialogRef} className="modal-dialog graphical-menu-settings-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key !== "Tab") return;
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)'));
        if (!items.length) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }}>
      <div className="codex-app-server-history-header"><h2 id={titleId}>{t("settings.graphicalMenuTitle")}</h2>
        <button type="button" disabled={busy} aria-label={t("common.close")} onClick={close}><X aria-hidden="true" /></button></div>
      <GraphicalMenuSettings initialProvider={initialProvider} onBusyChange={value => { busyRef.current = value; setBusy(value); }} />
    </div>
  </div>;
}
