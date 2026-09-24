import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function CodexSessionMirror({ sessionId, onError }: { sessionId: string; onError: (message: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let sequence = 0;
    let polling = false;
    let ready = false;
    const terminal = new Terminal({ cursorBlink: true, convertEol: true, scrollback: 5000,
      fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 12 });
    terminal.open(host);
    const writer = terminal.onData(data => {
      void window.projectAssistantApi.writeCodex(sessionId, data).catch(error => onError(errorText(error)));
    });
    const write = (data: string) => new Promise<void>(resolve => terminal.write(data, resolve));

    async function reset() {
      const screen = await window.projectAssistantApi.getCodexScreen(sessionId);
      if (disposed) return;
      terminal.resize(screen.cols, screen.rows);
      terminal.reset();
      await write(screen.ansi);
      sequence = screen.seq;
      ready = true;
    }

    async function poll() {
      if (polling || disposed) return;
      polling = true;
      try {
        const deltas = await window.projectAssistantApi.getCodexDeltas(sessionId, sequence);
        if (disposed) return;
        if (deltas === null) {
          await reset();
        } else {
          for (const delta of deltas) {
            if (delta.seq !== sequence + 1) { await reset(); break; }
            await write(delta.data);
            sequence = delta.seq;
          }
        }
      } catch (error) {
        if (!disposed) onError(errorText(error));
      } finally { polling = false; }
    }

    void reset().catch(error => { if (!disposed) onError(errorText(error)); });
    const timer = window.setInterval(() => { if (ready) void poll(); }, 120);
    return () => { disposed = true; window.clearInterval(timer); writer.dispose(); terminal.dispose(); };
  }, [sessionId, onError]);

  return <div className="project-assistant-terminal" ref={hostRef} aria-label="Codex terminal" />;
}
