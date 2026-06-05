import { useEffect } from "react";

type SettingsModalProps = {
  autoRestore: boolean;
  onToggleAutoRestore: () => void;
  onCancel: () => void;
};

export function SettingsModal({ autoRestore, onToggleAutoRestore, onCancel }: SettingsModalProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>设置</h3>
        </div>
        <div className="modal-body">
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
