import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { Maximize2, Minimize2, Minus, Pause, Play, Sparkles, X } from "lucide-react";
import type { AgentRunStatus, Locale } from "../../vite-env";
import mascotImage from "../../assets/mascot/panel-navigator.png";
import waveImage from "../../assets/mascot/gifs/panna-wave.gif";
import walkImage from "../../assets/mascot/gifs/panna-walk.gif";
import workingImage from "../../assets/mascot/gifs/panna-working.gif";
import celebrateImage from "../../assets/mascot/gifs/panna-celebrate.gif";
import stillImage from "../../assets/mascot/gifs/frames/idle/01.png";
import halfClosedImage from "../../assets/mascot/gifs/frames/idle/03.png";
import closedImage from "../../assets/mascot/gifs/frames/idle/04.png";
import "./DesktopMascot.css";
import { MarkdownBlock } from "../shared/MarkdownBlock";
import "../../styles/markdown-content.css";
import { MascotNotificationActions, MascotNotificationLabel } from "./MascotNotification";

export type MascotAction = "create" | "sessions" | "terminal" | "skills" | "mcp" | "settings";
type Preferences = { collapsed: boolean; animated: boolean; x?: number; y?: number };
const storageKey = "pannel-handle.desktop-mascot.v1";
const motionQuery = "(prefers-reduced-motion: reduce)";
const animations = {
  idle: { image: stillImage, duration: 3000 },
  wave: { image: waveImage, duration: 2080 },
  working: { image: workingImage, duration: 3000 },
  celebrate: { image: celebrateImage, duration: 2080 }
};
type Animation = keyof typeof animations;
const randomActions: Animation[] = ["wave", "working", "celebrate"];

function useMascotAnimation(allowed: boolean, roaming: boolean, attention: boolean) {
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.(motionQuery).matches ?? false);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [failed, setFailed] = useState(false);
  const [blinkFrame, setBlinkFrame] = useState(stillImage);
  const [playback, setPlayback] = useState<{ animation: Animation; serial: number; loaded: boolean }>({ animation: "idle", serial: 0, loaded: false });
  const previousAction = useRef<Animation | undefined>(undefined);
  const enabled = allowed && visible && !reducedMotion && !failed;

  useEffect(() => {
    const images = [stillImage, halfClosedImage, closedImage].map(src => {
      const image = new Image();
      image.onerror = () => setFailed(true);
      image.src = src;
      return image;
    });
    return () => images.forEach(image => { image.onerror = null; });
  }, []);

  useEffect(() => {
    const media = window.matchMedia?.(motionQuery);
    const motionChanged = () => setReducedMotion(media?.matches ?? false);
    const visibilityChanged = () => setVisible(!document.hidden);
    media?.addEventListener("change", motionChanged);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      media?.removeEventListener("change", motionChanged);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, []);
  useEffect(() => {
    setPlayback(current => ({ animation: attention ? "wave" : "idle", serial: current.serial + 1, loaded: false }));
  }, [enabled, roaming, attention]);
  useEffect(() => {
    if (!enabled || roaming || !playback.loaded) return;
    const idle = playback.animation === "idle";
    const delay = idle ? 8000 + Math.random() * 7000 : animations[playback.animation].duration;
    const timer = window.setTimeout(() => {
      let next: Animation = "idle";
      if (idle || attention) {
        const candidates = randomActions.filter(action => action !== playback.animation && action !== previousAction.current);
        next = candidates[Math.floor(Math.random() * candidates.length)];
        previousAction.current = next;
      }
      setPlayback(current => ({ animation: next, serial: current.serial + 1, loaded: false }));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [enabled, roaming, attention, playback]);

  useEffect(() => {
    setBlinkFrame(stillImage);
    if (!enabled || roaming || !playback.loaded || playback.animation !== "idle") return;
    let timer: number;
    const schedule = (callback: () => void, delay: number) => {
      timer = window.setTimeout(callback, delay);
    };
    const wait = () => schedule(() => blink(Math.random() < 0.25), 2500 + Math.random() * 3500);
    const blink = (double: boolean) => {
      setBlinkFrame(halfClosedImage);
      schedule(() => {
        setBlinkFrame(closedImage);
        schedule(() => {
          setBlinkFrame(halfClosedImage);
          schedule(() => {
            setBlinkFrame(stillImage);
            if (double) schedule(() => blink(false), 120 + Math.random() * 100);
            else wait();
          }, 80);
        }, 80);
      }, 60);
    };
    wait();
    return () => window.clearTimeout(timer);
  }, [enabled, roaming, playback.animation, playback.serial, playback.loaded]);

  return {
    enabled,
    failed,
    image: failed ? mascotImage : enabled ? roaming ? walkImage : playback.animation === "idle" ? blinkFrame : animations[playback.animation].image : stillImage,
    key: `${enabled ? roaming ? "walk" : "motion" : "still"}-${playback.serial}`,
    onLoad: () => {
      if (!enabled) return;
      setPlayback(current => current.serial === playback.serial && !current.loaded ? { ...current, loaded: true } : current);
    },
    onError: () => setFailed(true)
  };
}

function loadPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "null");
    return {
      collapsed: value?.collapsed === true,
      animated: value?.animated !== false,
      x: typeof value?.x === "number" && Number.isFinite(value.x) ? value.x : undefined,
      y: typeof value?.y === "number" && Number.isFinite(value.y) ? value.y : undefined
    };
  } catch { return { collapsed: false, animated: true }; }
}

function boundPosition(x: number, y: number, collapsed: boolean) {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - (collapsed ? 52 : 144) - 8)),
    y: Math.max(44, Math.min(y, window.innerHeight - (collapsed ? 52 : 232) - 8))
  };
}

export function DesktopMascot({ locale }: {
  locale: Locale;
  status?: AgentRunStatus;
  sessionTitle?: string;
  onAction: (action: MascotAction) => void;
}) {
  const desktop = window.desktopMascotApi;
  const [notifications, setNotifications] = useState<import("../../vite-env").DesktopMascotNotifications>({ revision: -1, notification: null, pendingCount: 0 });
  const [bubbleHovered, setBubbleHovered] = useState(false);
  const [bubbleFocused, setBubbleFocused] = useState(false);
  const notification = notifications.notification;
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [viewedId, setViewedId] = useState<string | null>(null);
  const bubbleOpen = Boolean(notification && openedId === notification.id);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const summaryExpanded = Boolean(notification && !notification.action && expandedId === notification.id);
  const [moving, setMoving] = useState(true);
  const [roaming, setRoaming] = useState(false);
  const [roamingDirection, setRoamingDirection] = useState<"left" | "right">("left");
  const [desktopReady, setDesktopReady] = useState(false);
  const [desktopLocale, setDesktopLocale] = useState(locale);
  const container = useRef<HTMLElement>(null);
  const zh = (desktop ? desktopLocale : locale) === "zh-CN";
  const [preferences, setPreferences] = useState(loadPreferences);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const animation = useMascotAnimation(preferences.animated && !preferences.collapsed, roaming, Boolean(notification && viewedId !== notification.id));
  const drag = useRef<{ id: number; x: number; y: number; startX: number; startY: number; active: boolean; timer: number; target: HTMLButtonElement } | undefined>(undefined);
  const suppressClick = useRef(false);
  const keyboardInteraction = useRef(true);
  const position = boundPosition(preferences.x ?? viewport.width - 172, preferences.y ?? viewport.height - 230, preferences.collapsed);
  const text = (cn: string, en: string) => zh ? cn : en;

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const apply = (state: import("../../vite-env").DesktopMascotState) => {
      if (disposed) return;
      setPreferences(current => ({ ...current, collapsed: state.collapsed, animated: state.animated }));
      setMoving(state.moving);
      setRoaming(state.roaming === true);
      setRoamingDirection(state.roamingDirection === "right" ? "right" : "left");
      setDesktopLocale(state.locale);
      setDesktopReady(true);
      if (state.notifications) applyNotifications(state.notifications);
    };
    const applyNotifications = (snapshot: import("../../vite-env").DesktopMascotNotifications) => {
      if (!disposed) setNotifications(current => snapshot.revision >= current.revision ? snapshot : current);
    };
    const unsubscribe = desktop.onState(apply);
    const unsubscribeNotifications = desktop.onNotifications(applyNotifications);
    void desktop.getState().then(state => {
      if (disposed) return;
      apply(state);
      if (!state.migrated) desktop.migrate(loadPreferences());
    });
    return () => { disposed = true; unsubscribe(); unsubscribeNotifications(); };
  }, [desktop]);
  useEffect(() => {
    if (desktop && notification) desktop.setNotificationPresentation(notification.id, bubbleOpen || bubbleHovered || bubbleFocused || summaryExpanded);
    if (!notification) { setBubbleHovered(false); setBubbleFocused(false); }
  }, [desktop, notification?.id, bubbleHovered, bubbleFocused, summaryExpanded, bubbleOpen]);
  useEffect(() => {
    setOpenedId(null); setViewedId(null); setExpandedId(null);
    setBubbleHovered(false); setBubbleFocused(false);
  }, [notification?.id]);
  useEffect(() => {
    if (!bubbleOpen) { setBubbleHovered(false); setBubbleFocused(false); }
  }, [bubbleOpen]);
  useEffect(() => {
    if (desktop && notification) desktop.setNotificationExpanded(notification.id, bubbleOpen);
  }, [desktop, notification?.id, bubbleOpen]);
  useEffect(() => {
    if (!notification || notification.action || expandedId !== notification.id) setExpandedId(null);
  }, [notification?.id, notification?.action, expandedId]);
  useEffect(() => {
    if (!desktop || !notification) return;
    desktop.setSummaryExpanded(notification.id, summaryExpanded);
  }, [desktop, notification?.id, summaryExpanded]);
  useEffect(() => {
    if (!bubbleOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setExpandedId(null); if (!summaryExpanded) setOpenedId(null); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [bubbleOpen, summaryExpanded]);
  useEffect(() => {
    if (!desktop || !desktopReady) return;
    const media = window.matchMedia?.(motionQuery);
    const report = () => desktop.setInteraction(hovered || focused || dragging, media?.matches ?? false);
    report();
    media?.addEventListener("change", report);
    return () => media?.removeEventListener("change", report);
  }, [desktop, desktopReady, hovered, focused, dragging]);
  useEffect(() => {
    if (!desktop || !desktopReady) return;
    desktop.setPreferences({ collapsed: preferences.collapsed });
  }, [desktop, desktopReady, preferences.collapsed]);
  useEffect(() => {
    if (!desktop || !container.current) return;
    // Alpha hit regions keep transparent margins clickable through to the desktop.
    const report = () => {
      const regions: { x: number; y: number; width: number; height: number }[] = [];
      const image = container.current?.querySelector("img");
      if (image?.complete && image.naturalWidth) {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d");
          if (context) {
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            const rect = image.getBoundingClientRect();
            const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
            const offsetX = rect.x + (rect.width - canvas.width * scale) / 2;
            const offsetY = rect.y + (rect.height - canvas.height * scale) / 2;
            for (let y = 0; y < canvas.height; y += 8) {
              let left = canvas.width, right = -1;
              for (let row = y; row < Math.min(y + 8, canvas.height); row++) for (let x = 0; x < canvas.width; x++) {
                if (pixels[(row * canvas.width + x) * 4 + 3] > 20) { left = Math.min(left, x); right = Math.max(right, x); }
              }
              if (right >= left) regions.push({ x: offsetX + left * scale, y: offsetY + y * scale, width: (right - left + 1) * scale, height: 8 * scale });
            }
          }
        } catch { /* Keep controls available if image pixels cannot be read. */ }
      }
      container.current?.querySelectorAll(preferences.collapsed ? "button" : ".desktop-mascot-controls:not([hidden]) button, .desktop-mascot-message-button").forEach(button => {
        const rect = button.getBoundingClientRect();
        regions.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      });
      const bubble = container.current?.querySelector(".desktop-mascot-bubble");
      if (bubble) {
        const rect = bubble.getBoundingClientRect();
        regions.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      }
      desktop.setRegions(regions);
    };
    report();
    const image = container.current.querySelector("img");
    image?.addEventListener("load", report);
    window.addEventListener("resize", report);
    const timer = window.setInterval(report, 250);
    return () => { window.clearInterval(timer); image?.removeEventListener("load", report); window.removeEventListener("resize", report); };
  }, [desktop, preferences.collapsed, hovered, focused, animation.key, notification?.id, summaryExpanded, bubbleOpen]);
  useEffect(() => {
    if (desktop) return;
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* Preferences are optional. */ }
  }, [preferences]);
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => () => {
    const current = drag.current;
    if (!current) return;
    window.clearTimeout(current.timer);
    drag.current = undefined;
    desktop?.endDrag();
    if (current.target.hasPointerCapture(current.id)) current.target.releasePointerCapture(current.id);
  }, []);

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    window.clearTimeout(current.timer);
    drag.current = undefined;
    setDragging(false);
    desktop?.endDrag();
    if (current.target.hasPointerCapture(current.id)) current.target.releasePointerCapture(current.id);
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !event.isPrimary || drag.current) return;
    suppressClick.current = false;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const current = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: position.x, startY: position.y, active: false, timer: 0, target };
    current.timer = window.setTimeout(() => {
      if (drag.current !== current) return;
      current.active = true;
      suppressClick.current = true;
      setDragging(true);
      desktop?.startDrag();
    }, 50);
    drag.current = current;
    if (desktop) setDragging(true);
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    if (!current.active) {
      current.x = event.clientX;
      current.y = event.clientY;
      return;
    }
    if (desktop) return;
    const next = boundPosition(current.startX + event.clientX - current.x, current.startY + event.clientY - current.y, preferences.collapsed);
    setPreferences(value => ({ ...value, ...next }));
  }

  const style: CSSProperties = desktop ? { left: 0, top: 0 } : { left: position.x, top: position.y };
  return (
    <aside ref={container} className={`desktop-mascot${desktop ? " is-desktop-window" : ""}${bubbleOpen ? ` has-notification${notification?.action ? " has-request" : ""}` : ""}${summaryExpanded ? " is-summary-expanded" : ""}${notification ? " has-message" : ""}${preferences.collapsed ? " is-collapsed" : ""}${dragging ? " is-dragging" : ""}`} style={style} aria-label={text("看板娘小帕", "Panna companion")}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onPointerDownCapture={() => { keyboardInteraction.current = false; setFocused(false); }}
      onKeyDownCapture={() => { keyboardInteraction.current = true; setFocused(true); }}
      onFocus={event => { if (keyboardInteraction.current || event.target.matches(":focus-visible")) setFocused(true); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
      {notification && bubbleOpen && <section className={`desktop-mascot-bubble is-${notification.status}`} role="status" aria-live="polite" tabIndex={0}
        onMouseEnter={() => setBubbleHovered(true)} onMouseLeave={() => setBubbleHovered(false)}
        onFocus={() => setBubbleFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setBubbleFocused(false); }}>
        <div className="desktop-mascot-bubble-header">
          <strong><MascotNotificationLabel notification={notification} locale={desktop ? desktopLocale : locale} /></strong>
          {notifications.pendingCount > 1 && <span>{text(`另有 ${notifications.pendingCount - 1} 条`, `${notifications.pendingCount - 1} more`)}</span>}
          {!notification.action && <button type="button" title={summaryExpanded ? text("收起摘要", "Collapse summary") : text("放大查看", "Expand summary")} aria-label={summaryExpanded ? text("收起摘要", "Collapse summary") : text("放大查看", "Expand summary")} aria-expanded={summaryExpanded} onClick={() => setExpandedId(summaryExpanded ? null : notification.id)}>{summaryExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>}
          <button type="button" title={text("关闭任务气泡", "Dismiss task result")} aria-label={text("关闭任务气泡", "Dismiss task result")} onClick={() => desktop?.dismissNotification(notification.id)}><X size={16} /></button>
        </div>
        <div className="desktop-mascot-bubble-title" title={notification.sessionTitle}>{notification.sessionTitle}</div>
        {notification.action ? <MascotNotificationActions key={notification.id} notification={notification} />
          : <div className="desktop-mascot-summary-container" onClick={event => {
            if (summaryExpanded || (event.target as Element).closest("a, button, input, summary, details") || window.getSelection()?.toString()) return;
            setExpandedId(notification.id);
          }}><MarkdownBlock className="desktop-mascot-summary" externalLinks content={notification.summary === "暂无摘要" ? text("暂无摘要", "No summary available") : notification.summary} /></div>}
      </section>}
      {notification && <button type="button" className="desktop-mascot-message-button" aria-expanded={bubbleOpen} onClick={() => {
        setOpenedId(bubbleOpen ? null : notification.id); setViewedId(notification.id); setExpandedId(null);
      }}>{bubbleOpen ? text("收起消息", "Hide message") : text("查看消息", "View message")} ({notifications.pendingCount})</button>}
      {!preferences.collapsed && <div className="desktop-mascot-controls" hidden={!hovered && !focused}>
        {desktop && <button type="button" title={moving ? text("暂停随机移动", "Pause roaming") : text("恢复随机移动", "Resume roaming")} aria-label={moving ? text("暂停随机移动", "Pause roaming") : text("恢复随机移动", "Resume roaming")} onClick={() => desktop.setPreferences({ moving: !moving })}>{moving ? <Pause size={14} /> : <Play size={14} />}</button>}
        <button type="button" title={text("收起看板娘", "Minimize companion")} aria-label={text("收起看板娘", "Minimize companion")} onClick={() => setPreferences(current => ({ ...current, collapsed: true }))}><Minus size={14} /></button>
      </div>}
      <button type="button" className="desktop-mascot-character" aria-label={preferences.collapsed ? text("展开看板娘", "Expand companion") : text("拖动看板娘（方向键移动）", "Move companion (arrow keys)")}
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
        onKeyDown={event => {
          const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
          if (delta) {
            event.preventDefault();
            if (desktop) { desktop.step(({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const)[event.key as "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"]); return; }
            setPreferences(current => ({ ...current, ...boundPosition(position.x + delta[0], position.y + delta[1], current.collapsed) }));
          } else if (event.key === "Enter" || event.key === " ") suppressClick.current = false;
        }}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          if (preferences.collapsed) setPreferences(current => ({ ...current, collapsed: false }));
        }}>
        {preferences.collapsed ? <Sparkles size={24} /> : <img key={animation.key} className={animation.failed ? undefined : `desktop-mascot-frame${animation.enabled && roaming && roamingDirection === "right" ? " is-walking-right" : ""}`} src={animation.image} onLoad={animation.onLoad} onError={animation.onError} alt="" draggable={false} />}
      </button>
    </aside>
  );
}
