import { useState } from "react";
import type { TerminalSession } from "../vite-env";

type EditSessionModalProps = {
  session: TerminalSession;
  onSave: (id: string, title: string, initialCommand: string) => void;
  onCancel: () => void;
};

export function EditSessionModal({ session, onSave, onCancel }: EditSessionModalProps) {
  const [editTitle, setEditTitle] = useState(session.title);
  const [editCommand, setEditCommand] = useState(session.initialCommand || "");

  const handleSave = () => {
    onSave(session.id, editTitle, editCommand);
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
          <input
            className="modal-input"
            placeholder="输入初始命令（可选），如：cd D:\\projects\\myapp"
            value={editCommand}
            onChange={(e) => setEditCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSave();
              }
              if (e.key === "Escape") {
                onCancel();
              }
            }}
          />
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
