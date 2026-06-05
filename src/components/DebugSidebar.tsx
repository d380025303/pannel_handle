import { useEffect, useMemo, useRef, useState } from "react";
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
  const eventListRef = useRef<HTMLDivElement | null>(null);

  const filteredEvents = useMemo(() => {
    if (providerFilter === "all") return events;
    return events.filter((event) => event.provider === providerFilter);
  }, [events, providerFilter]);

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
          filteredEvents.map((event, index) => (
            <article className="debug-event" key={`${event.timestamp}-${index}`}>
              <div className="debug-event-meta">
                <span className={`debug-provider ${event.provider}`}>{event.provider}</span>
                <span>{formatTime(event.timestamp)}</span>
                <span className={event.handled ? "debug-handled" : "debug-unhandled"}>
                  {event.handled ? "handled" : "unhandled"}
                </span>
              </div>
              <div className="debug-event-title">{event.eventName}</div>
              <div className="debug-event-session">{event.matchedSessionId || "No matched session"}</div>
              <pre>{JSON.stringify(event.payload, null, 2)}</pre>
            </article>
          ))
        )}
      </div>
    </aside>
  );
}
