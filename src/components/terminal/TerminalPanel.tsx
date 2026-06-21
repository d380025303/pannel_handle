import type { MouseEvent, RefObject, WheelEvent } from "react";

type TerminalPanelProps = {
  terminalHostRef: RefObject<HTMLDivElement | null>;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
  onWheel: (event: WheelEvent<HTMLDivElement>) => void;
};

export function TerminalPanel({
  terminalHostRef,
  onContextMenu,
  onWheel
}: TerminalPanelProps) {
  return (
    <section className="terminal-panel">
      <div className="terminal-host" ref={terminalHostRef} onContextMenu={onContextMenu} onWheel={onWheel} />
    </section>
  );
}
