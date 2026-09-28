type IconName = "more" | "close" | "send" | "stop" | "retry" | "refresh" | "remove" | "chevron"
  | "shield" | "mode" | "model" | "agent" | "history" | "new" | "file" | "back" | "check" | "command";

export function GraphicalIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    close: <path d="M18 6 6 18M6 6l12 12" />,
    send: <><path d="m5 12 14-7-4 14-3-6-7-1Z" /><path d="m12 13 7-8" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    retry: <><path d="M20 11a8 8 0 1 1-2.4-5.7" /><path d="M20 4v7h-7" /></>,
    refresh: <><path d="M20 11a8 8 0 1 1-2.4-5.7" /><path d="M20 4v7h-7" /></>,
    remove: <path d="M18 6 6 18M6 6l12 12" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></>,
    mode: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m8 9 3 3-3 3M13 15h4" /></>,
    model: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 9h6v6H9zM9 1v3m6-3v3M9 20v3m6-3v3M1 9h3m-3 6h3m16-6h3m-3 6h3" /></>,
    agent: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    new: <><path d="M12 5v14M5 12h14" /><circle cx="12" cy="12" r="10" /></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M12 11v7m-3-4h6" /></>,
    back: <path d="m15 18-6-6 6-6" />,
    check: <path d="m5 12 4 4L19 6" />,
    command: <><path d="M8 9V7a3 3 0 1 0-3 3h2v4H5a3 3 0 1 0 3 3v-2h8v2a3 3 0 1 0 3-3h-2v-4h2a3 3 0 1 0-3-3v2H8Z" /></>
  };
  return <svg className="graphical-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
import type { ReactNode } from "react";
