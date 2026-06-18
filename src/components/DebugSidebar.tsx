import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import type { AgentHookDebugPayload, AgentProvider, TerminalSession } from "../vite-env";
import { SearchableSelect } from "./SearchableSelect";

type DebugSidebarProps = {
  events: AgentHookDebugPayload[];
  sessions: TerminalSession[];
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

export function DebugSidebar({ events, sessions, onClear }: DebugSidebarProps) {
  const { t } = useI18n();
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  const [sessionFilter, setSessionFilter] = useState<string>("all");
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const eventListRef = useRef<HTMLDivElement | null>(null);
  const sessionOptions = useMemo(() => [
    { value: "all", label: t("debug.allInstances") },
    { value: "__no_session__", label: t("debug.noMatchedSession") },
    ...sessions.map((session) => ({ value: session.id, label: session.id }))
  ], [sessions, t]);

  const filteredEvents = useMemo(() => {
    let result = providerFilter === "all" ? events : events.filter((event) => event.provider === providerFilter);
    if (sessionFilter !== "all") {
      result = result.filter((event) =>
        sessionFilter === "__no_session__" ? !event.matchedSessionId : event.matchedSessionId === sessionFilter
      );
    }
    return result;
  }, [events, providerFilter, sessionFilter]);

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
          <h2>{t("tabs.debug")}</h2>
          <span>{t("debug.eventsCount", { count: filteredEvents.length })}</span>
        </div>
        <button className="icon-button" type="button" title={t("debug.clearEvents")} aria-label={t("debug.clearEvents")} onClick={onClear}>
          <Trash2 aria-hidden="true" />
        </button>
      </div>

      <div className="debug-filter" role="group" aria-label={t("debug.providerFilter")}>
        {(["all", "claude", "codex", "opencode", "qoder"] as ProviderFilter[]).map((provider) => (
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

      <div className="debug-session-filter">
        <SearchableSelect
          value={sessionFilter}
          options={sessionOptions}
          ariaLabel={t("debug.allInstances")}
          onChange={setSessionFilter}
        />
      </div>

      <div className="debug-event-list" ref={eventListRef}>
        {filteredEvents.length === 0 ? (
          <div className="debug-empty">{t("debug.noEvents")}</div>
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
                  <span className="debug-event-session-id">{event.matchedSessionId || t("debug.noMatchedSession")}</span>
                  <span className="debug-event-sep">·</span>
                  <span>{formatTime(event.timestamp)}</span>
                  <span className={event.handled ? "debug-handled" : "debug-unhandled"}>
                    {event.handled ? t("debug.handled") : t("debug.unhandled")}
                  </span>
                  <span
                    className="debug-toggle-payload"
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleExpand(key)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggleExpand(key); }}
                  >
                    {expanded ? "▾ payload" : "▸ payload"}
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
