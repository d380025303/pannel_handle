import { useMemo, useState } from "react";
import type { TerminalSession } from "../vite-env";

type SessionPickerModalProps = {
  pendingSessions: TerminalSession[];
  runningSessions: TerminalSession[];
  pickerManual: boolean;
  onLaunch: (sessions: TerminalSession[]) => void;
  onStartFresh: () => void;
  onDelete: (id: string) => void;
  onCancel: () => void;
};

export function SessionPickerModal({
  pendingSessions,
  runningSessions,
  pickerManual,
  onLaunch,
  onStartFresh,
  onDelete,
  onCancel
}: SessionPickerModalProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set()
  );
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const runningCounts = useMemo(() => {
    return runningSessions.reduce((counts, session) => {
      if (!session.templateId) {
        return counts;
      }
      counts.set(session.templateId, (counts.get(session.templateId) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());
  }, [runningSessions]);
  const toLaunch = pendingSessions.filter((session) => selectedIds.has(session.id));

  return (
    <div className="modal-overlay" onClick={() => { setConfirmDeleteId(null); onCancel(); }}>
      <div className="modal-dialog session-picker-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{pickerManual ? "会话库" : "恢复会话"}</h3>
          <p className="modal-subtitle">
            {pickerManual ? "选择要从库中启动的会话" : "选择要启动的会话"}
          </p>
        </div>
        <div className="modal-body">
          {pendingSessions.length === 0 ? (
            <div className="picker-empty">
              <p>没有已保存的会话</p>
            </div>
          ) : (
            <div className="picker-list">
              {pendingSessions.map((session) => {
                const runningCount = runningCounts.get(session.id) ?? 0;
                const isRunning = runningCount > 0;
                const isChecked = selectedIds.has(session.id);
                return (
                  <label
                    key={session.id}
                    className={`picker-item ${isChecked ? "checked" : ""} ${isRunning ? "running" : ""}`}
                  >
                    <input
                      type="checkbox"
                      className="picker-checkbox"
                      checked={isChecked}
                      onChange={() => {
                        setConfirmDeleteId(null);
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(session.id)) {
                            next.delete(session.id);
                          } else {
                            next.add(session.id);
                          }
                          return next;
                        });
                      }}
                    />
                    <span className="picker-item-info">
                      <span className="picker-item-title">{session.title}</span>
                      <span className={`session-type-badge ${session.type}`}>
                        {session.type === "wsl" ? (session.wslDistro || "WSL") : "PS"}
                      </span>
                      {isRunning && (
                        <span className="picker-running-badge">运行中 {runningCount}</span>
                      )}
                    </span>
                    <span
                      className={`picker-delete-btn${confirmDeleteId === session.id ? " confirm" : ""}`}
                      title={confirmDeleteId === session.id ? "再次点击确认删除" : "从库中删除"}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        if (confirmDeleteId === session.id) {
                          onDelete(session.id);
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            next.delete(session.id);
                            return next;
                          });
                          setConfirmDeleteId(null);
                        } else {
                          setConfirmDeleteId(session.id);
                        }
                      }}
                    >
                      {confirmDeleteId === session.id ? "确认" : "×"}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
        <div className="modal-footer">
          {!pickerManual && (
            <button
              className="modal-button"
              type="button"
              onClick={onStartFresh}
            >
              重新开始
            </button>
          )}
          <button
            className="modal-button"
            type="button"
            onClick={onCancel}
          >
            {pickerManual ? "关闭" : "取消"}
          </button>
          <button
            className="modal-button primary"
            type="button"
            onClick={() => onLaunch(toLaunch)}
            disabled={toLaunch.length === 0}
          >
            启动所选 ({toLaunch.length})
          </button>
        </div>
      </div>
    </div>
  );
}
