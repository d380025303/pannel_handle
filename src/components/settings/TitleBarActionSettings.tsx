import { GripVertical } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../i18n";
import type { TitleBarActionId } from "../app/titleBarActions";
import { TITLE_BAR_ACTIONS } from "../app/titleBarActions";

type Props = {
  order: TitleBarActionId[];
  hidden: TitleBarActionId[];
  screenshotEnabled: boolean;
  onChange: (change: { titleBarActionOrder?: TitleBarActionId[]; titleBarHiddenActions?: TitleBarActionId[] }) => Promise<void>;
};

export function TitleBarActionSettings({ order, hidden, screenshotEnabled, onChange }: Props) {
  const { t } = useI18n();
  const [draggedId, setDraggedId] = useState<TitleBarActionId | null>(null);
  const [dropId, setDropId] = useState<TitleBarActionId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labels = new Map(TITLE_BAR_ACTIONS.map(action => [action.id, t(action.labelKey)]));

  const save = async (change: Parameters<Props["onChange"]>[0]) => {
    setBusy(true);
    setError(null);
    try {
      await onChange(change);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const move = (source: TitleBarActionId, target: TitleBarActionId) => {
    if (source === target || busy) return;
    const next = order.filter(id => id !== source);
    next.splice(next.indexOf(target), 0, source);
    void save({ titleBarActionOrder: next });
  };

  return <section className="settings-section titlebar-action-settings">
    <div className="settings-card-header"><div>
      <h4>{t("settings.titleBarActionsTitle")}</h4>
      <p className="settings-help">{t("settings.titleBarActionsHint")}</p>
    </div></div>
    <div className="titlebar-action-list">
      {order.map(id => <div key={id} className={`titlebar-action-row${dropId === id ? " drag-over" : ""}`}
        onDragOver={event => { if (draggedId && draggedId !== id) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropId(id); } }}
        onDragLeave={() => setDropId(current => current === id ? null : current)}
        onDrop={event => { event.preventDefault(); if (draggedId) move(draggedId, id); setDraggedId(null); setDropId(null); }}>
        <span className="titlebar-action-grip" draggable={!busy} role="button" tabIndex={0}
          aria-label={t("settings.titleBarDrag", { name: labels.get(id) ?? id })}
          onKeyDown={event => {
            const index = order.indexOf(id);
            if (event.key === "ArrowUp" && index > 0) { event.preventDefault(); move(id, order[index - 1]); }
            if (event.key === "ArrowDown" && index < order.length - 1) { event.preventDefault(); move(id, order[index + 1]); }
          }}
          onDragStart={event => { setDraggedId(id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); }}
          onDragEnd={() => { setDraggedId(null); setDropId(null); }}>
          <GripVertical aria-hidden="true" />
        </span>
        <span className="titlebar-action-name">{labels.get(id)}</span>
        {id === "screenshot" && !screenshotEnabled && <span className="settings-help">{t("settings.titleBarScreenshotUnavailable")}</span>}
        <label className="titlebar-action-visibility">
          <input type="checkbox" checked={!hidden.includes(id)} disabled={busy}
            aria-label={t("settings.titleBarShow", { name: labels.get(id) ?? id })}
            onChange={event => void save({ titleBarHiddenActions: event.target.checked ? hidden.filter(item => item !== id) : [...hidden, id] })} />
          <span>{t("settings.titleBarVisible")}</span>
        </label>
      </div>)}
    </div>
    {error && <p className="settings-result error" role="alert">{t("settings.titleBarSaveFailed")}: {error}</p>}
  </section>;
}
