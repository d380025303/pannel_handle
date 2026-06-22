import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { useI18n } from "../../i18n";
import type { CompletionMetricCounters, CompletionMetrics, TerminalSession } from "../../vite-env";
import { SearchableSelect } from "../shared/SearchableSelect";
import type { CompletionDebugEntry } from "./completionDebug";

type CompletionDebugSidebarProps = {
  entries: CompletionDebugEntry[];
  sessions: TerminalSession[];
  onClear: () => void;
};

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatPayload(value: string | undefined) {
  if (!value) return "";
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function formatRequest(entry: CompletionDebugEntry) {
  if (!entry.request) return "";
  let body: unknown = entry.request.body;
  try {
    body = JSON.parse(entry.request.body);
  } catch {
    // Keep the exact body text when it is not JSON.
  }
  return JSON.stringify({ headers: entry.request.headers, body }, null, 2);
}

function sumMetrics(metrics: CompletionMetrics | null) {
  const total: CompletionMetricCounters = {
    shown: 0,
    accepted: 0,
    dismissed: 0,
    submittedAfterAccept: 0,
    zeroEditSubmissions: 0,
    editDistanceTotal: 0,
    finalLengthTotal: 0,
    errors: 0,
    latencyBuckets: { lt250: 0, lt1000: 0, lt3000: 0, gte3000: 0 }
  };
  if (!metrics) return total;
  for (const mode of Object.values(metrics.totals)) {
    for (const counters of Object.values(mode)) {
      for (const key of ["shown", "accepted", "dismissed", "submittedAfterAccept", "zeroEditSubmissions", "editDistanceTotal", "finalLengthTotal", "errors"] as const) {
        total[key] += counters[key];
      }
    }
  }
  return total;
}

function formatRate(numerator: number, denominator: number) {
  return denominator > 0 ? `${Math.round(numerator / denominator * 100)}%` : "—";
}

export function CompletionDebugSidebar({ entries, sessions, onClear }: CompletionDebugSidebarProps) {
  const { t } = useI18n();
  const [sessionFilter, setSessionFilter] = useState("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [metrics, setMetrics] = useState<CompletionMetrics | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sessionOptions = useMemo(() => [
    { value: "all", label: t("completionDebug.allSessions") },
    ...sessions.map((session) => ({ value: session.id, label: `${session.title} · ${session.id}` }))
  ], [sessions, t]);
  const filteredEntries = useMemo(
    () => sessionFilter === "all" ? entries : entries.filter((entry) => entry.sessionId === sessionFilter),
    [entries, sessionFilter]
  );
  const metricTotals = useMemo(() => sumMetrics(metrics), [metrics]);

  useEffect(() => {
    let disposed = false;
    const refresh = () => window.completionApi.getMetrics()
      .then((result) => {
        if (!disposed) setMetrics(result);
      })
      .catch(() => {});
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [filteredEntries.length]);

  const toggleExpanded = (requestId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(requestId)) next.delete(requestId);
      else next.add(requestId);
      return next;
    });
  };

  return (
    <aside className="debug-sidebar completion-debug-sidebar">
      <div className="debug-sidebar-header">
        <div>
          <h2>{t("tabs.completionDebug")}</h2>
          <span>{t("completionDebug.eventsCount", { count: filteredEntries.length })}</span>
        </div>
        <button className="icon-button" type="button" title={t("completionDebug.clear")} aria-label={t("completionDebug.clear")} onClick={onClear}>
          <Trash2 aria-hidden="true" />
        </button>
      </div>

      <div className="debug-session-filter">
        <SearchableSelect
          value={sessionFilter}
          options={sessionOptions}
          ariaLabel={t("completionDebug.allSessions")}
          onChange={setSessionFilter}
        />
      </div>

      <section className="completion-metrics-summary">
        <div className="completion-metrics-heading">
          <strong>{t("completionDebug.metricsTitle")}</strong>
          <button
            className="debug-toggle-payload"
            type="button"
            onClick={() => void window.completionApi.clearMetrics().then(setMetrics).catch(() => {})}
          >
            {t("completionDebug.clearMetrics")}
          </button>
        </div>
        <div className="completion-metrics-values">
          <span>{t("completionDebug.metricsShown", { count: metricTotals.shown })}</span>
          <span>{t("completionDebug.metricsAccepted", { rate: formatRate(metricTotals.accepted, metricTotals.shown) })}</span>
          <span>{t("completionDebug.metricsZeroEdit", { rate: formatRate(metricTotals.zeroEditSubmissions, metricTotals.submittedAfterAccept) })}</span>
          <span>{t("completionDebug.metricsErrors", { count: metricTotals.errors })}</span>
        </div>
      </section>

      <div className="debug-event-list" ref={listRef}>
        {filteredEntries.length === 0 ? (
          <div className="debug-empty">{t("completionDebug.noEvents")}</div>
        ) : filteredEntries.map((entry) => {
          const expanded = expandedIds.has(entry.requestId);
          const statusLabel = entry.status === "pending"
            ? t("completionDebug.status.pending")
            : entry.status === "success"
              ? t("completionDebug.status.success")
              : t("completionDebug.status.error");
          return (
            <article className="debug-event completion-debug-event" key={entry.requestId}>
              <div className="debug-event-meta">
                <span className={`completion-debug-status ${entry.status}`}>{statusLabel}</span>
                <span className="debug-event-session-id">{entry.sessionId}</span>
                <span className="debug-event-sep">·</span>
                <span>{formatTime(entry.startedAt)}</span>
                {entry.httpStatus != null && <span>HTTP {entry.httpStatus}</span>}
                {entry.durationMs != null && <span>{entry.durationMs} ms</span>}
                <button className="debug-toggle-payload" type="button" onClick={() => toggleExpanded(entry.requestId)}>
                  {expanded ? t("completionDebug.collapse") : t("completionDebug.expand")}
                </button>
              </div>
              {expanded && (
                <div className="completion-debug-details">
                  {entry.request && (
                    <section>
                      <h3>{t("completionDebug.request")}</h3>
                      <div className="completion-debug-endpoint">{entry.request.method} {entry.request.url}</div>
                      <pre>{formatRequest(entry)}</pre>
                    </section>
                  )}
                  {entry.responseBody != null && (
                    <section>
                      <h3>{t("completionDebug.response")}</h3>
                      <pre>{formatPayload(entry.responseBody)}</pre>
                    </section>
                  )}
                  {entry.completion != null && (
                    <section>
                      <h3>{t("completionDebug.result")}</h3>
                      <pre>{entry.completion || t("completionDebug.emptyResult")}</pre>
                    </section>
                  )}
                  {entry.error && (
                    <section>
                      <h3>{t("completionDebug.error")}</h3>
                      <pre className="completion-debug-error">{entry.error}</pre>
                    </section>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </aside>
  );
}
