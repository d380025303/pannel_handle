import type { MouseEvent, RefObject } from "react";
import type { AgentStatusPayload, TerminalSession } from "../vite-env";
import { getAgentStatusClass, getAgentStatusLabel } from "../utils/agentStatus";

type TerminalPanelProps = {
  activeSession?: TerminalSession;
  activeAgentStatus?: AgentStatusPayload;
  terminalHostRef: RefObject<HTMLDivElement | null>;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
};

export function TerminalPanel({
  activeSession,
  activeAgentStatus,
  terminalHostRef,
  onContextMenu
}: TerminalPanelProps) {
  const activeAgentStatusLabel = getAgentStatusLabel(activeAgentStatus);

  return (
    <section className="terminal-panel">
      <header className="terminal-header">
        <div>
          <h2>{activeSession?.title || "未选择会话"}</h2>
          <span>
            {activeSession
              ? (activeSession.type === "wsl" ? `WSL - ${activeSession.wslDistro || "Linux"}` : "PowerShell")
              : "没有正在运行的命令窗口"}
          </span>
        </div>
        {activeAgentStatusLabel && (
          <span className={`terminal-agent-status ${getAgentStatusClass(activeAgentStatus)}`}>
            {activeAgentStatusLabel}
          </span>
        )}
      </header>
      <div className="terminal-host" ref={terminalHostRef} onContextMenu={onContextMenu} />
    </section>
  );
}
