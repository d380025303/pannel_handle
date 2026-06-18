import { useState } from "react";
import { Play } from "lucide-react";
import { useI18n } from "../i18n";
import type { QuickCommand } from "../vite-env";

type QuickCommandBarProps = {
  quickCommands: QuickCommand[];
  activeSessionId?: string;
  onFocusTerminal: () => void;
  onAddQuickCommand: (command: string, mode: QuickCommand["mode"]) => void;
  onRemoveQuickCommand: (id: string) => void;
};

export function QuickCommandBar({ quickCommands, activeSessionId, onFocusTerminal, onAddQuickCommand, onRemoveQuickCommand }: QuickCommandBarProps) {
  const { t } = useI18n();
  const [addInput, setAddInput] = useState("");

  if (!activeSessionId) {
    return null;
  }

  const handleClick = (qc: QuickCommand) => {
    const mode = qc.mode || "write";
    if (mode === "auto-enter") {
      window.terminalApi.write(activeSessionId, qc.command + "\r");
    } else {
      window.terminalApi.write(activeSessionId, qc.command);
    }
    if (mode === "one-time") {
      onRemoveQuickCommand(qc.id);
    }
    onFocusTerminal();
  };

  const handleAdd = () => {
    const cmd = addInput.trim();
    if (!cmd) return;
    onAddQuickCommand(cmd, "one-time");
    setAddInput("");
  };

  return (
    <div className="quick-command-bar">
      {quickCommands.map((qc) => (
        <button
          key={qc.id}
          className="quick-command-btn"
          type="button"
          title={qc.command}
          onClick={() => handleClick(qc)}
        >
          <Play aria-hidden="true" size={12} />
          <span className="quick-command-label">{qc.command}</span>
        </button>
      ))}
      <input
        className="quick-command-add-input"
        type="text"
        placeholder={t("quickCommand.placeholder")}
        value={addInput}
        onChange={(e) => setAddInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && addInput.trim()) {
            handleAdd();
          }
        }}
      />
    </div>
  );
}
