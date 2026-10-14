import { useI18n } from "../../i18n";
import type { WorkspaceEntryTypeFilter } from "../../vite-env";

export function workspaceMentionFilterKey(event: { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }): WorkspaceEntryTypeFilter | null {
  if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return null;
  return event.key === "1" ? "all" : event.key === "2" ? "directory" : event.key === "3" ? "file" : null;
}

export function WorkspaceMentionFilter({ value }: { value: WorkspaceEntryTypeFilter }) {
  const { t } = useI18n();
  return <div className="workspace-mention-filter" role="group" aria-live="polite" aria-label={t("composer.filterType")}>
    {(["all", "directory", "file"] as const).map((type, index) => <span key={type} className="workspace-mention-filter-item" data-active={value === type}>
      {t(type === "all" ? "composer.filterAll" : type === "directory" ? "composer.filterDirectories" : "composer.filterFiles")} <kbd>Ctrl+{index + 1}</kbd>
      {value === type && <span className="workspace-mention-filter-current"> · {t("composer.filterCurrent")}</span>}
    </span>)}
  </div>;
}
