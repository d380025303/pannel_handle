import { useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

export type VirtualFileTreeHandle = { focus: (index: number) => void };

type Props = {
  paths: string[];
  resetKey: string;
  handleRef: RefObject<VirtualFileTreeHandle | null>;
  busy: boolean;
  onScroll: () => void;
  empty: ReactNode;
  renderRow: (index: number) => ReactNode;
};

// Keep the DOM proportional to the viewport, including rows with inline editors/messages.
export function VirtualFileTree({ paths, resetKey, handleRef, busy, onScroll, empty, renderRow }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const pendingFocus = useRef<number | null>(null);
  const [view, setView] = useState({ top: 0, height: 400 });
  const [, invalidate] = useState(0);
  const offsets = [0];
  for (const path of paths) offsets.push(offsets[offsets.length - 1] + (heights.current.get(path) ?? 31));
  const total = offsets[paths.length];
  const top = Math.min(view.top, Math.max(0, total - view.height));
  const findIndex = (position: number) => {
    let low = 0;
    let high = paths.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (offsets[mid + 1] <= position) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const start = Math.max(0, findIndex(top) - 10);
  const end = Math.min(paths.length, findIndex(top + view.height) + 11);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resize = () => setView((current) => ({ ...current, height: element.clientHeight || 400 }));
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    heights.current.clear();
    pendingFocus.current = null;
    if (viewport.current) viewport.current.scrollTop = 0;
    setView((current) => ({ ...current, top: 0 }));
  }, [resetKey]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    if (element.scrollTop > Math.max(0, total - view.height)) {
      element.scrollTop = top;
      setView((current) => ({ ...current, top }));
    }
    const active = new Set(paths);
    for (const path of heights.current.keys()) if (!active.has(path)) heights.current.delete(path);
    const measure = () => {
      let changed = false;
      for (const row of element.querySelectorAll<HTMLElement>("[data-virtual-index]")) {
        const index = Number(row.dataset.virtualIndex);
        const height = row.getBoundingClientRect().height;
        if (height > 0 && heights.current.get(paths[index]) !== height) {
          heights.current.set(paths[index], height);
          changed = true;
        }
      }
      if (changed) invalidate((value) => value + 1);
    };
    measure();
    const target = pendingFocus.current;
    if (target !== null) {
      const button = element.querySelector<HTMLButtonElement>(`[data-virtual-index="${target}"] [role="treeitem"]`);
      if (button) { button.focus({ preventScroll: true }); pendingFocus.current = null; }
    }
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    for (const row of element.querySelectorAll("[data-virtual-index]")) observer.observe(row);
    return () => observer.disconnect();
  });

  useImperativeHandle(handleRef, () => ({ focus(index: number) {
    const element = viewport.current;
    if (!element || index < 0 || index >= paths.length) return;
    pendingFocus.current = index;
    const nextTop = offsets[index] < top ? offsets[index]
      : offsets[index + 1] > top + view.height ? Math.max(0, offsets[index + 1] - view.height) : top;
    element.scrollTop = nextTop;
    setView((current) => ({ ...current, top: nextTop }));
  } }));

  return <div ref={viewport} className="remote-file-list remote-file-virtual-list" role="tree" aria-busy={busy}
    onScroll={(event) => { onScroll(); const scrollTop = event.currentTarget.scrollTop; setView((current) => ({ ...current, top: scrollTop })); }}>
    {paths.length === 0 ? empty : <div className="remote-file-virtual-spacer" style={{ height: total }}>
      {paths.slice(start, end).map((path, offset) => {
        const index = start + offset;
        return <div key={path} data-virtual-index={index} className="remote-file-virtual-row" style={{ top: offsets[index] }}>{renderRow(index)}</div>;
      })}
    </div>}
  </div>;
}
