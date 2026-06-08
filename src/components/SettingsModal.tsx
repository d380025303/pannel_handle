import { useEffect } from "react";

type SettingsModalProps = {
  autoRestore: boolean;
  debugMode: boolean;
  onToggleAutoRestore: () => void;
  onToggleDebugMode: () => void;
  onCancel: () => void;
};

export function SettingsModal({
  autoRestore,
  debugMode,
  onToggleAutoRestore,
  onToggleDebugMode,
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
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>设置</h3>
        </div>
        <div className="modal-body settings-body">
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
