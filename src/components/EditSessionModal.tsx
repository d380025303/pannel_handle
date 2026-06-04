import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { QuickCommand, TerminalSession } from "../vite-env";

type EditSessionModalProps = {
  session: TerminalSession;
  onSave: (id: string, title: string, initialCommand: string, quickCommands: QuickCommand[]) => void;
  onCancel: () => void;
};

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

export function EditSessionModal({ session, onSave, onCancel }: EditSessionModalProps) {
  const [editTitle, setEditTitle] = useState(session.title);
  const [editCommand, setEditCommand] = useState(session.initialCommand || "");
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>(
    () => session.quickCommands ?? []
  );

  const handleSave = () => {
    onSave(session.id, editTitle, editCommand, quickCommands);
  };

  const handleAddCommand = () => {
    setQuickCommands((prev) => [
      ...prev,
      { id: generateId(), label: "", command: "" }
    ]);
  };

  const handleRemoveCommand = (id: string) => {
    setQuickCommands((prev) => prev.filter((qc) => qc.id !== id));
  };

  const handleCommandChange = (id: string, field: "label" | "command", value: string) => {
    setQuickCommands((prev) =>
      prev.map((qc) => (qc.id === id ? { ...qc, [field]: value } : qc))
    );
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>编辑会话</h3>
        </div>
        <div className="modal-body">
          <label className="modal-label">会话名称</label>
          <input
            autoFocus
            className="modal-input"
            placeholder="输入会话名称"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
          />
          <label className="modal-label" style={{ marginTop: "12px" }}>
            初始命令
          </label>
          <textarea
            className="modal-input modal-textarea"
            placeholder="输入初始命令（可选），如：cd D:\\projects\\myapp"
            value={editCommand}
            onChange={(e) => setEditCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                onCancel();
              }
            }}
            rows={3}
          />
          <label className="modal-label" style={{ marginTop: "16px" }}>
            快捷命令
          </label>
          <div className="quick-command-edit-list">
            {quickCommands.map((qc) => (
              <div key={qc.id} className="quick-command-edit-row">
                <input
                  className="modal-input quick-cmd-input"
                  placeholder="显示名称"
                  value={qc.label}
                  onChange={(e) => handleCommandChange(qc.id, "label", e.target.value)}
                />
                <input
                  className="modal-input quick-cmd-input"
                  placeholder="命令内容"
                  value={qc.command}
                  onChange={(e) => handleCommandChange(qc.id, "command", e.target.value)}
                />
                <button
                  type="button"
                  className="mini-action danger"
                  onClick={() => handleRemoveCommand(qc.id)}
                  title="删除"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="quick-command-add-btn"
              onClick={handleAddCommand}
            >
              <Plus size={14} />
              <span>添加命令</span>
            </button>
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-button" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="modal-button primary" type="button" onClick={handleSave}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
