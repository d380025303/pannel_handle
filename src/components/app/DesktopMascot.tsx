import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { Minus, Sparkles } from "lucide-react";
import type { AgentRunStatus, Locale } from "../../vite-env";
import mascotImage from "../../assets/mascot/panel-navigator.png";
import waveImage from "../../assets/mascot/gifs/panna-wave.gif";
import workingImage from "../../assets/mascot/gifs/panna-working.gif";
import celebrateImage from "../../assets/mascot/gifs/panna-celebrate.gif";
import stillImage from "../../assets/mascot/gifs/frames/idle/01.png";
import halfClosedImage from "../../assets/mascot/gifs/frames/idle/03.png";
import closedImage from "../../assets/mascot/gifs/frames/idle/04.png";
import "./DesktopMascot.css";

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

function useMascotAnimation(allowed: boolean) {
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
    setPlayback(current => ({ animation: "idle", serial: current.serial + 1, loaded: false }));
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !playback.loaded) return;
    const idle = playback.animation === "idle";
    const delay = idle ? 8000 + Math.random() * 7000 : animations[playback.animation].duration;
    const timer = window.setTimeout(() => {
      let next: Animation = "idle";
      if (idle) {
        const candidates = randomActions.filter(action => action !== previousAction.current);
        next = candidates[Math.floor(Math.random() * candidates.length)];
        previousAction.current = next;
      }
      setPlayback(current => ({ animation: next, serial: current.serial + 1, loaded: false }));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [enabled, playback]);

  useEffect(() => {
    setBlinkFrame(stillImage);
    if (!enabled || !playback.loaded || playback.animation !== "idle") return;
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
  }, [enabled, playback.animation, playback.serial, playback.loaded]);

  return {
    enabled,
    failed,
    image: failed ? mascotImage : enabled ? playback.animation === "idle" ? blinkFrame : animations[playback.animation].image : stillImage,
    key: `${enabled ? "motion" : "still"}-${playback.serial}`,
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
  const zh = locale === "zh-CN";
  const [preferences, setPreferences] = useState(loadPreferences);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const animation = useMascotAnimation(preferences.animated && !preferences.collapsed);
  const drag = useRef<{ id: number; x: number; y: number; startX: number; startY: number; active: boolean; timer: number; target: HTMLButtonElement } | undefined>(undefined);
  const suppressClick = useRef(false);
  const keyboardInteraction = useRef(true);
  const position = boundPosition(preferences.x ?? viewport.width - 172, preferences.y ?? viewport.height - 230, preferences.collapsed);
  const text = (cn: string, en: string) => zh ? cn : en;

  useEffect(() => {
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
    if (current.target.hasPointerCapture(current.id)) current.target.releasePointerCapture(current.id);
  }, []);

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    window.clearTimeout(current.timer);
    drag.current = undefined;
    setDragging(false);
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
    }, 50);
    drag.current = current;
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    if (!current.active) {
      current.x = event.clientX;
      current.y = event.clientY;
      return;
    }
    const next = boundPosition(current.startX + event.clientX - current.x, current.startY + event.clientY - current.y, preferences.collapsed);
    setPreferences(value => ({ ...value, ...next }));
  }

  const style: CSSProperties = { left: position.x, top: position.y };
  return (
    <aside className={`desktop-mascot${preferences.collapsed ? " is-collapsed" : ""}${dragging ? " is-dragging" : ""}`} style={style} aria-label={text("看板娘小帕", "Panna companion")}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onPointerDownCapture={() => { keyboardInteraction.current = false; setFocused(false); }}
      onKeyDownCapture={() => { keyboardInteraction.current = true; setFocused(true); }}
      onFocus={event => { if (keyboardInteraction.current || event.target.matches(":focus-visible")) setFocused(true); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
      {!preferences.collapsed && <div className="desktop-mascot-controls" hidden={!hovered && !focused}>
        <button type="button" aria-label={text("收起看板娘", "Minimize companion")} onClick={() => setPreferences(current => ({ ...current, collapsed: true }))}><Minus size={18} /></button>
      </div>}
      <button type="button" className="desktop-mascot-character" aria-label={preferences.collapsed ? text("展开看板娘", "Expand companion") : text("拖动看板娘（方向键移动）", "Move companion (arrow keys)")}
        title={text("长按拖动位置，或使用方向键", "Hold to drag or use arrow keys")}
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
        onKeyDown={event => {
          const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
          if (delta) {
            event.preventDefault();
            setPreferences(current => ({ ...current, ...boundPosition(position.x + delta[0], position.y + delta[1], current.collapsed) }));
          } else if (event.key === "Enter" || event.key === " ") suppressClick.current = false;
        }}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          if (preferences.collapsed) setPreferences(current => ({ ...current, collapsed: false }));
        }}>
        {preferences.collapsed ? <Sparkles size={24} /> : <img key={animation.key} className={animation.failed ? undefined : "desktop-mascot-frame"} src={animation.image} onLoad={animation.onLoad} onError={animation.onError} alt="" draggable={false} />}
      </button>
    </aside>
  );
}
