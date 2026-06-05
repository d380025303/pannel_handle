import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { AgentHookDebugPayload, AgentProvider } from "../vite-env";

type DebugSidebarProps = {
  events: AgentHookDebugPayload[];
  onClear: () => void;
};

type ProviderFilter = "all" | AgentProvider;

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function DebugSidebar({ events, onClear }: DebugSidebarProps) {
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const eventListRef = useRef<HTMLDivElement | null>(null);

  const filteredEvents = useMemo(() => {
    if (providerFilter === "all") return events;
    return events.filter((event) => event.provider === providerFilter);
  }, [events, providerFilter]);

  const toggleExpand = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const element = eventListRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [filteredEvents.length]);

  return (
    <aside className="debug-sidebar">
      <div className="debug-sidebar-header">
        <div>
          <h2>Debug</h2>
          <span>{filteredEvents.length} hook events</span>
        </div>
        <button className="icon-button" type="button" title="Clear events" aria-label="Clear events" onClick={onClear}>
          <Trash2 aria-hidden="true" />
        </button>
      </div>

      <div className="debug-filter" role="group" aria-label="Provider filter">
        {(["all", "claude", "codex"] as ProviderFilter[]).map((provider) => (
          <button
            key={provider}
            className={providerFilter === provider ? "active" : ""}
            type="button"
            onClick={() => setProviderFilter(provider)}
          >
            {provider}
          </button>
        ))}
      </div>

      <div className="debug-event-list" ref={eventListRef}>
        {filteredEvents.length === 0 ? (
          <div className="debug-empty">No hook events yet</div>
        ) : (
          filteredEvents.map((event, index) => {
            const key = `${event.timestamp}-${index}`;
            const expanded = expandedKeys.has(key);
            return (
              <article className="debug-event" key={key}>
                <div className="debug-event-meta">
                  <span className={`debug-provider ${event.provider}`}>{event.provider}</span>
                  <span className="debug-event-name">{event.eventName}</span>
                  <span className="debug-event-sep">·</span>
                  <span className="debug-event-session-id">{event.matchedSessionId || "No matched session"}</span>
                  <span className="debug-event-sep">·</span>
                  <span>{formatTime(event.timestamp)}</span>
                  <span className={event.handled ? "debug-handled" : "debug-unhandled"}>
                    {event.handled ? "handled" : "unhandled"}
                  </span>
                  <span
                    className="debug-toggle-payload"
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleExpand(key)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggleExpand(key); }}
                  >
                    {expanded ? "▼ payload" : "▶ payload"}
                  </span>
                </div>
                {expanded && (
                  <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                )}
              </article>
            );
          })
        )}
      </div>
    </aside>
  );
}
