import { Settings } from "lucide-react";
import { useI18n } from "../../i18n";
import { Children, Fragment, cloneElement, isValidElement, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

// Flatten only fragments, preserving each existing action's controls and capability gates.
function flattenActions(children: ReactNode, prefix = ""): ReactNode[] {
  return Children.toArray(children).flatMap((child, index) => {
    const key = `${prefix}:${index}`;
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) {
      return flattenActions(child.props.children, key);
    }
    return [isValidElement(child) ? cloneElement(child, { key }) : child];
  });
}

export function GraphicalActionMenu({ children, secondaryActions = [], mobile = false, menuRef, onClose, onConfigure }: {
  children: ReactNode;
  secondaryActions?: string[];
  mobile?: boolean;
  menuRef?: RefObject<HTMLDivElement | null>;
  onClose?: () => void;
  onConfigure?: () => void;
}) {
  const { t } = useI18n();
  const localRef = useRef<HTMLDivElement>(null);
  const rootRef = menuRef || localRef;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [secondary, setSecondary] = useState(false);
  const nodes = flattenActions(children);
  const isSecondary = (node: ReactNode) => isValidElement<{ "data-action"?: string }>(node)
    && Boolean(node.props["data-action"] && secondaryActions.includes(node.props["data-action"]!));
  const nested = nodes.filter(isSecondary);
  const primary = nodes.filter(node => !isSecondary(node));
  const showingSecondary = secondary && nested.length > 0;
  const wasSecondary = useRef(false);
  useLayoutEffect(() => {
    if (secondary && !nested.length) setSecondary(false);
    if (wasSecondary.current === showingSecondary) return;
    wasSecondary.current = showingSecondary;
    if (showingSecondary) (rootRef.current?.querySelector<HTMLElement>("[data-action] button:not(:disabled), button[data-action]:not(:disabled), input:not(:disabled)")
      || rootRef.current?.querySelector<HTMLButtonElement>("button"))?.focus();
    else (triggerRef.current || rootRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
  }, [showingSecondary, secondary, nested.length, rootRef]);

  return <div ref={rootRef} className={mobile ? "graphical-sheet-list" : "codex-app-server-menu"}
    role={mobile ? "group" : "menu"} aria-label={t(showingSecondary ? "graphicalMenu.other" : "graphicalMenu.actions")}
    onKeyDown={event => {
      if ((event.key === "Escape" || event.key === "ArrowLeft") && showingSecondary) {
        event.preventDefault(); event.stopPropagation(); setSecondary(false); return;
      }
      if (event.key === "ArrowRight" && event.target === triggerRef.current) {
        event.preventDefault(); setSecondary(true); return;
      }
      if (event.key === "Escape") { event.preventDefault(); onClose?.(); return; }
      if (event.key === "Tab" && !mobile) { onClose?.(); return; }
      if (mobile || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
    {!mobile && onConfigure && <div className="graphical-menu-toolbar"><button type="button" role="menuitem" title={t("graphicalMenu.configure")} aria-label={t("graphicalMenu.configure")} onClick={onConfigure}><Settings aria-hidden="true" /></button></div>}
    {showingSecondary ? <>
      <button type="button" role={mobile ? undefined : "menuitem"} onClick={() => setSecondary(false)}>‹ {t("graphicalMenu.back")}</button>
      {nested}
    </> : <>
      {primary}
      {nested.length > 0 && <button ref={triggerRef} type="button" className="graphical-menu-secondary-trigger" role={mobile ? undefined : "menuitem"}
        aria-haspopup={mobile ? undefined : "menu"} aria-expanded={false} onClick={() => setSecondary(true)}>{t("graphicalMenu.other")} <span aria-hidden="true">›</span></button>}
    </>}
  </div>;
}
