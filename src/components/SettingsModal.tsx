import { useEffect } from "react";
import type { AppTheme } from "../themes";
import type { ThemeId } from "../vite-env";

type SettingsModalProps = {
  autoRestore: boolean;
  debugMode: boolean;
  themeId: ThemeId;
  themes: AppTheme[];
  onToggleAutoRestore: () => void;
  onToggleDebugMode: () => void;
  onThemeChange: (themeId: ThemeId) => void;
  onCancel: () => void;
};

export function SettingsModal({
  autoRestore,
  debugMode,
  themeId,
  themes,
  onToggleAutoRestore,
  onToggleDebugMode,
  onThemeChange,
  onCancel
}: SettingsModalProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div className="modal-overlay">
      <div className="modal-dialog settings-dialog">
        <div className="modal-header">
          <h3>设置</h3>
        </div>
        <div className="modal-body settings-body">
          <section className="settings-section">
            <label className="auto-restore-label">
              <input
                type="checkbox"
                className="auto-restore-checkbox"
                checked={autoRestore}
                onChange={onToggleAutoRestore}
              />
              <span className="auto-restore-track" />
              <span className="auto-restore-text">启动时自动恢复</span>
            </label>
            <label className="auto-restore-label">
              <input
                type="checkbox"
                className="auto-restore-checkbox"
                checked={debugMode}
                onChange={onToggleDebugMode}
              />
              <span className="auto-restore-track" />
              <span className="auto-restore-text">Debug 模式</span>
            </label>
            <label className="settings-field">
              <span className="modal-label">主题</span>
              <select
                className="modal-input settings-theme-select"
                value={themeId}
                onChange={(event) => onThemeChange(event.target.value as ThemeId)}
              >
                {themes.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.label}
                  </option>
                ))}
              </select>
            </label>
          </section>

        </div>
        <div className="modal-footer">
          <button className="modal-button primary" type="button" onClick={onCancel}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
