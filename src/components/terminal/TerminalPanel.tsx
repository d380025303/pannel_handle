import type { MouseEvent, WheelEvent } from "react";
import type { TerminalSession } from "../../vite-env";

type TerminalPanelProps = {
  sessions: TerminalSession[];
  activeId?: string;
  hostRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
  onWheel: (event: WheelEvent<HTMLDivElement>) => void;
};

export function TerminalPanel({
  sessions,
  activeId,
  hostRefs,
  onContextMenu,
  onWheel
}: TerminalPanelProps) {
  return (
    <section className="terminal-panel">
      <div className="terminal-hosts-container" onContextMenu={onContextMenu} onWheel={onWheel}>
        {sessions.map((session) => (
          <div
            key={session.id}
            className="terminal-host"
            data-session-id={session.id}
            style={{ display: session.id === activeId ? undefined : "none" }}
            ref={(el) => {
              if (el) {
                hostRefs.current.set(session.id, el);
              } else {
                hostRefs.current.delete(session.id);
              }
            }}
          />
        ))}
      </div>
    </section>
  );
}
