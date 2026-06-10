import { useCallback, useEffect, useRef } from "react";
import type { MouseEvent } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";

type TerminalEntry = {
  terminal: Terminal;
  fitAddon: FitAddon;
  mountedSessionId?: string;
};

type UseTerminalInstancesOptions = {
  activeId?: string;
};

function createTerminalEntry() {
  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: "Cascadia Mono, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.2,
    theme: {
      background: "#101318",
      foreground: "#e7edf4",
      cursor: "#ffffff",
      selectionBackground: "#35506c",
      black: "#15191f",
      red: "#df6b75",
      green: "#76c38f",
      yellow: "#d7b46a",
      blue: "#6ca8e7",
      magenta: "#c792ea",
      cyan: "#64c9cf",
      white: "#e7edf4",
      brightBlack: "#626a73",
      brightRed: "#f07f89",
      brightGreen: "#8ad9a4",
      brightYellow: "#e8c981",
      brightBlue: "#82bbf7",
      brightMagenta: "#d7a5f4",
      brightCyan: "#80dde1",
      brightWhite: "#ffffff"
    }
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  return { terminal, fitAddon };
}

export function useTerminalInstances({ activeId }: UseTerminalInstancesOptions) {
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalsRef = useRef(new Map<string, TerminalEntry>());

  const copyTerminalSelection = useCallback(async (terminal: Terminal) => {
    if (!terminal.hasSelection()) {
      return false;
    }

    const selection = terminal.getSelection();
    if (!selection) {
      return false;
    }

    const didCopy = await window.clipboardApi.writeText(selection);
    if (didCopy) {
      terminal.clearSelection();
    }
    return didCopy;
  }, []);

  const handleTerminalContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();

    const entry = activeId ? terminalsRef.current.get(activeId) : undefined;
    if (!entry) {
      return;
    }

    if (entry.terminal.hasSelection()) {
      void copyTerminalSelection(entry.terminal);
      return;
    }

    window.clipboardApi.readText().then((text) => {
      if (text && activeId) {
        window.terminalApi.write(activeId, text);
      }
    });
    entry.terminal.focus();
  }, [activeId, copyTerminalSelection]);

  const focusActiveTerminal = useCallback(() => {
    if (!activeId) return;
    const entry = terminalsRef.current.get(activeId);
    if (entry) {
      entry.terminal.focus();
    }
  }, [activeId]);

  const disposeTerminal = useCallback((id: string) => {
    const entry = terminalsRef.current.get(id);
    if (entry) {
      entry.terminal.dispose();
      terminalsRef.current.delete(id);
    }
  }, []);

  useEffect(() => {
    const removeDataListener = window.terminalApi.onData(({ id, data }) => {
      const entry = terminalsRef.current.get(id);
      if (entry) {
        entry.terminal.write(data);
      }
    });

    const removeExitListener = window.terminalApi.onExit(({ id, exitCode }) => {
      const entry = terminalsRef.current.get(id);
      if (entry) {
        entry.terminal.writeln(`\r\n[进程已退出，退出码 ${exitCode}]`);
      }
    });

    return () => {
      removeDataListener();
      removeExitListener();
    };
  }, []);

  useEffect(() => {
    if (!activeId || !terminalHostRef.current) {
      return;
    }

    terminalHostRef.current.replaceChildren();
    let entry = terminalsRef.current.get(activeId);

    if (!entry) {
      entry = createTerminalEntry();
      entry.terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") {
          return true;
        }

        const isPasteKey =
          (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "v") ||
          (event.shiftKey && !event.ctrlKey && !event.altKey && event.key === "Insert");

        if (isPasteKey) {
          window.clipboardApi.readText().then((text) => {
            if (text && activeId) {
              window.terminalApi.write(activeId, text);
            }
          });
          return false;
        }

        if (event.key === "Enter" && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
          if (activeId) {
            window.terminalApi.write(activeId, "\n");
          }
          return false;
        }

        if (!event.ctrlKey || event.altKey) {
          return true;
        }

        const isCopyKey = event.key.toLowerCase() === "c";
        if (!isCopyKey) {
          return true;
        }

        const hasSelection = entry?.terminal.hasSelection() ?? false;
        if (event.shiftKey) {
          if (hasSelection && entry) {
            void copyTerminalSelection(entry.terminal);
          }
          return false;
        }

        if (hasSelection && entry) {
          void copyTerminalSelection(entry.terminal);
          return false;
        }

        return true;
      });
      entry.terminal.onData((data) => {
        window.terminalApi.write(activeId, data);
      });
      terminalsRef.current.set(activeId, entry);

      window.terminalApi.getHistory(activeId).then((history) => {
        if (history) {
          entry?.terminal.write(history);
        }
      });
    }

    entry.terminal.open(terminalHostRef.current);
    entry.mountedSessionId = activeId;

    const textarea = terminalHostRef.current.querySelector(
      ".xterm-helper-textarea"
    ) as HTMLTextAreaElement | null;

    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };

    textarea?.addEventListener("paste", onPaste, true);

    const fit = () => {
      try {
        entry?.fitAddon.fit();
        const dims = entry?.fitAddon.proposeDimensions();
        if (dims) {
          window.terminalApi.resize(activeId, dims.cols, dims.rows);
        }
      } catch {
        // xterm can throw while the host is hidden during fast session switches.
      }
    };

    fit();
    entry.terminal.focus();
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(terminalHostRef.current);

    return () => {
      textarea?.removeEventListener("paste", onPaste, true);
      resizeObserver.disconnect();
    };
  }, [activeId, copyTerminalSelection]);

  useEffect(() => {
    return () => {
      terminalsRef.current.forEach((entry) => entry.terminal.dispose());
      terminalsRef.current.clear();
    };
  }, []);

  return {
    terminalHostRef,
    handleTerminalContextMenu,
    disposeTerminal,
    focusActiveTerminal
  };
}
