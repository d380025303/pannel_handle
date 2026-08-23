import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Pin, PinOff, Play, Plus } from "lucide-react";
import { useI18n } from "../../i18n";
import type { QuickCommand } from "../../vite-env";

type QuickCommandBarProps = {
  quickCommands: QuickCommand[];
  activeSessionId?: string;
  onFocusTerminal: () => void;
  onAddQuickCommand: (command: string, mode: QuickCommand["mode"]) => void | Promise<void>;
  onRemoveQuickCommand: (id: string) => void | Promise<void>;
  onTogglePinned: (id: string) => void | Promise<void>;
};

const MAX_PINNED_COMMANDS = 3;

export function QuickCommandBar({ quickCommands, activeSessionId, onFocusTerminal, onAddQuickCommand, onRemoveQuickCommand, onTogglePinned }: QuickCommandBarProps) {
  const { t } = useI18n();
  const [addInput, setAddInput] = useState("");
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const pinnedCount = quickCommands.filter((command) => command.pinned).length;
  const directCommands = useMemo(() => {
    const pinned = quickCommands.filter((command) => command.pinned).slice(0, MAX_PINNED_COMMANDS);
    const fallback = quickCommands.filter((command) => !command.pinned).slice(0, MAX_PINNED_COMMANDS - pinned.length);
    return [...pinned, ...fallback];
  }, [quickCommands]);

  const closePopover = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  const updatePopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 8;
    const gap = 8;
    const width = Math.min(620, window.innerWidth - viewportPadding * 2);
    const left = Math.min(Math.max(viewportPadding, rect.left), window.innerWidth - width - viewportPadding);
    setPopoverStyle({
      left,
      width,
      bottom: window.innerHeight - rect.top + gap,
      maxHeight: Math.max(180, rect.top - viewportPadding - gap)
    });
  }, []);

  useEffect(() => {
    closePopover();
  }, [activeSessionId, closePopover]);

  useEffect(() => {
    if (!open) return undefined;
    updatePopoverPosition();
    const handleViewportChange = () => updatePopoverPosition();
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) closePopover();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePopover(true);
      }
    };
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closePopover, open, updatePopoverPosition]);

  if (!activeSessionId) return null;

  const executeCommand = (command: QuickCommand) => {
    const mode = command.mode || "write";
    window.terminalApi.write(activeSessionId, mode === "auto-enter" ? `${command.command}\r` : command.command);
    if (mode === "one-time") void onRemoveQuickCommand(command.id);
    closePopover();
    onFocusTerminal();
  };

  const handleAdd = () => {
    const command = addInput.trim();
    if (!command) return;
    void onAddQuickCommand(command, "one-time");
    setAddInput("");
  };

  const modeLabel = (command: QuickCommand) => {
    if (command.mode === "auto-enter") return t("quickCommand.autoEnter");
    if (command.mode === "one-time") return t("quickCommand.oneTime");
    return t("quickCommand.write");
  };

  return (
    <div className="quick-command-bar">
      {directCommands.map((command, index) => (
        <button
          key={command.id}
          className={`quick-command-btn quick-command-direct slot-${index + 1}${command.pinned ? " pinned" : ""}`}
          type="button"
          title={command.command}
          onClick={() => executeCommand(command)}
        >
          <Play aria-hidden="true" size={12} />
          <span className="quick-command-label">{command.command}</span>
        </button>
      ))}
      <button
        ref={triggerRef}
        className="quick-command-btn quick-command-more"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("quickCommand.dialog")}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{quickCommands.length > 0 ? t("quickCommand.more") : t("quickCommand.heading")}</span>
        {quickCommands.length > 0 && <span className="quick-command-count">{quickCommands.length}</span>}
        <ChevronDown aria-hidden="true" />
      </button>

      {open && createPortal(
        <div ref={popoverRef} className="quick-command-popover" role="dialog" aria-label={t("quickCommand.dialog")} style={popoverStyle}>
          <div className="quick-command-popover-heading">
            <strong>{t("quickCommand.dialog")}</strong>
            <span>{pinnedCount}/{MAX_PINNED_COMMANDS}</span>
          </div>
          {quickCommands.length > 0 ? (
            <div className="quick-command-grid">
              {quickCommands.map((command) => {
                const pinDisabled = !command.pinned && pinnedCount >= MAX_PINNED_COMMANDS;
                const pinTitle = command.pinned ? t("quickCommand.unpin") : pinDisabled ? t("quickCommand.pinLimit") : t("quickCommand.pin");
                return (
                  <div className={`quick-command-card ${command.pinned ? "pinned" : ""}`} key={command.id}>
                    <button className="quick-command-card-run" type="button" title={command.command} onClick={() => executeCommand(command)}>
                      <Play aria-hidden="true" />
                      <span>
                        <strong>{command.command}</strong>
                        <small>{modeLabel(command)}</small>
                      </span>
                    </button>
                    <button
                      className="quick-command-pin"
                      type="button"
                      disabled={pinDisabled}
                      title={pinTitle}
                      aria-label={`${pinTitle}: ${command.command}`}
                      onClick={() => void onTogglePinned(command.id)}
                    >
                      {command.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="quick-command-empty">{t("quickCommand.empty")}</div>
          )}
          <div className="quick-command-create">
            <input
              className="quick-command-add-input"
              type="text"
              aria-label={t("quickCommand.commandPlaceholder")}
              placeholder={t("quickCommand.placeholder")}
              value={addInput}
              onChange={(event) => setAddInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && addInput.trim()) handleAdd();
              }}
            />
            <button type="button" disabled={!addInput.trim()} title={t("quickCommand.add")} aria-label={t("quickCommand.add")} onClick={handleAdd}>
              <Plus aria-hidden="true" />
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
