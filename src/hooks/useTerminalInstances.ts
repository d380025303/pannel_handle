import { useCallback, useEffect, useRef } from "react";
import type { MouseEvent } from "react";
import { Terminal, type ITheme } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { useI18n } from "../i18n";
import { createImeInputGuard } from "../utils/terminalInput";

type TerminalEntry = {
  terminal: Terminal;
  fitAddon: FitAddon;
  inputGuard: ReturnType<typeof createImeInputGuard>;
  mountedSessionId?: string;
};

type UseTerminalInstancesOptions = {
  activeId?: string;
  terminalTheme: ITheme;
};

function getErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function getTerminalStatusMessage(err: unknown) {
  return getErrorMessage(err).replace(/[\x00-\x1F\x7F]/g, " ").slice(0, 240);
}

function createTerminalEntry(terminalTheme: ITheme) {
  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: "Cascadia Mono, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.2,
    theme: terminalTheme
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  const inputGuard = createImeInputGuard();
  return { terminal, fitAddon, inputGuard };
}

export function useTerminalInstances({ activeId, terminalTheme }: UseTerminalInstancesOptions) {
  const { t } = useI18n();
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

  const pasteIntoTerminal = useCallback(async (sessionId: string, terminal: Terminal) => {
    try {
      const imageResult = await window.clipboardApi.pasteImageToSession(sessionId);
      if (imageResult.status === "saved") {
        window.terminalApi.write(sessionId, imageResult.path);
        return;
      }

      const text = await window.clipboardApi.readText();
      if (text) {
        window.terminalApi.write(sessionId, text);
      }
    } catch (err) {
      console.error("Failed to paste clipboard image:", err);
      terminal.writeln(`\r\n${t("terminal.imagePasteFailed", { message: getTerminalStatusMessage(err) })}`);
    }
  }, [t]);

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
        entry.terminal.writeln(`\r\n${t("terminal.exited", { exitCode })}`);
      }
    });

    return () => {
      removeDataListener();
      removeExitListener();
    };
  }, [t]);

  useEffect(() => {
    if (!activeId || !terminalHostRef.current) {
      return;
    }

    const terminalHost = terminalHostRef.current;
    let entry = terminalsRef.current.get(activeId);

    if (!entry) {
      entry = createTerminalEntry(terminalTheme);
      const sessionId = activeId;
      entry.terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") {
          return true;
        }

        if (event.isComposing) {
          return true;
        }

        const isPasteKey =
          (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "v") ||
          (event.shiftKey && !event.ctrlKey && !event.altKey && event.key === "Insert");

        if (isPasteKey) {
          if (entry) {
            void pasteIntoTerminal(sessionId, entry.terminal);
          }
          return false;
        }

        if (event.key === "Enter" && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
          window.terminalApi.write(sessionId, "\n");
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
        if (entry?.inputGuard.shouldForwardData(data) ?? true) {
          window.terminalApi.write(sessionId, data);
        }
      });
      terminalsRef.current.set(activeId, entry);

      window.terminalApi.getHistory(activeId).then((history) => {
        if (history) {
          entry?.terminal.write(history);
        }
      });
    }

    if (!entry.terminal.element) {
      terminalHost.replaceChildren();
      entry.terminal.open(terminalHost);
    } else if (entry.terminal.element.parentElement !== terminalHost) {
      terminalHost.replaceChildren(entry.terminal.element);
    }
    entry.mountedSessionId = activeId;

    const textarea = entry.terminal.textarea;

    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onCompositionStart = () => entry?.inputGuard.handleCompositionStart();
    const onCompositionEnd = () => entry?.inputGuard.handleCompositionEnd();
    const onBeforeInput = (event: Event) => {
      entry?.inputGuard.handleBeforeInput(event as InputEvent);
    };
    const onInput = (event: Event) => {
      entry?.inputGuard.handleInput(event as InputEvent);
    };

    textarea?.addEventListener("paste", onPaste, true);
    textarea?.addEventListener("compositionstart", onCompositionStart);
    textarea?.addEventListener("compositionend", onCompositionEnd);
    textarea?.addEventListener("beforeinput", onBeforeInput);
    textarea?.addEventListener("input", onInput);

    const fit = () => {
      try {
        entry?.fitAddon.fit();
        const dims = entry?.fitAddon.proposeDimensions();
        if (dims && dims.cols > 0 && dims.rows > 0) {
          window.terminalApi.resize(activeId, dims.cols, dims.rows);
        }
      } catch {
        // xterm can throw while the host is hidden during fast session switches.
      }
    };

    fit();
    entry.terminal.focus();
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(terminalHost);

    return () => {
      textarea?.removeEventListener("paste", onPaste, true);
      textarea?.removeEventListener("compositionstart", onCompositionStart);
      textarea?.removeEventListener("compositionend", onCompositionEnd);
      textarea?.removeEventListener("beforeinput", onBeforeInput);
      textarea?.removeEventListener("input", onInput);
      resizeObserver.disconnect();
    };
  }, [activeId, copyTerminalSelection, pasteIntoTerminal, terminalTheme]);

  useEffect(() => {
    terminalsRef.current.forEach((entry) => {
      entry.terminal.options.theme = terminalTheme;
    });
  }, [terminalTheme]);

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
