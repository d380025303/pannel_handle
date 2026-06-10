import { Play } from "lucide-react";
import type { QuickCommand } from "../vite-env";

type QuickCommandBarProps = {
  quickCommands: QuickCommand[];
  activeSessionId?: string;
  onFocusTerminal: () => void;
};

export function QuickCommandBar({ quickCommands, activeSessionId, onFocusTerminal }: QuickCommandBarProps) {
  if (!quickCommands || quickCommands.length === 0 || !activeSessionId) {
    return null;
  }

  const handleClick = (command: string) => {
    window.terminalApi.write(activeSessionId, command);
    onFocusTerminal();
  };

  return (
    <div className="quick-command-bar">
      {quickCommands.map((qc) => (
        <button
          key={qc.id}
          className="quick-command-btn"
          type="button"
          title={qc.command}
          onClick={() => handleClick(qc.command)}
        >
          <Play aria-hidden="true" size={12} />
          <span className="quick-command-label">{qc.label || qc.command}</span>
        </button>
      ))}
    </div>
  );
}
