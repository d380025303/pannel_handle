import type { MouseEvent, RefObject } from "react";

type TerminalPanelProps = {
  terminalHostRef: RefObject<HTMLDivElement | null>;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
};

export function TerminalPanel({
  terminalHostRef,
  onContextMenu
}: TerminalPanelProps) {
  return (
    <section className="terminal-panel">
      <div className="terminal-host" ref={terminalHostRef} onContextMenu={onContextMenu} />
    </section>
  );
}
