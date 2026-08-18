import { useCallback, useEffect, useState } from "react";
import { Check, Clipboard, History, LoaderCircle } from "lucide-react";
import { useI18n } from "../../i18n";
import type { AgentOutputRun } from "../../vite-env";
import { getAgentProviderLabel } from "../sessions/agentProviders";
import { MarkdownBlock } from "../shared/MarkdownBlock";

type AgentOutputPanelProps = {
  activeSessionId?: string;
  activeTemplateId?: string;
  onHistoryAvailabilityChange?: (available: boolean) => void;
};

const PAGE_SIZE = 50;

export function AgentOutputPanel({ activeSessionId, activeTemplateId, onHistoryAvailabilityChange }: AgentOutputPanelProps) {
  const { t } = useI18n();
  const [scope, setScope] = useState<"current" | "all">("current");
  const [runs, setRuns] = useState<AgentOutputRun[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState<string>();

  const load = useCallback(async (append = false) => {
    if (scope === "current" && !activeSessionId) {
      setRuns([]);
      setTotal(0);
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    append ? setLoadingMore(true) : setLoading(true);
    setError("");
    try {
      const result = await window.agentOutputApi.list({
        scope,
        sessionId: activeSessionId,
        templateId: activeTemplateId,
        offset: append ? runs.length : 0,
        limit: PAGE_SIZE
      });
      setRuns((current) => append ? [...current, ...result.runs] : result.runs);
      setTotal(result.total);
      if (result.total > 0) onHistoryAvailabilityChange?.(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [activeSessionId, activeTemplateId, onHistoryAvailabilityChange, runs.length, scope]);

  useEffect(() => {
    void load(false);
  }, [activeSessionId, activeTemplateId, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => window.agentOutputApi.onChanged((payload) => {
    if (scope === "all" || payload.sessionId === activeSessionId || (activeTemplateId && payload.templateId === activeTemplateId)) {
      void load(false);
    }
    onHistoryAvailabilityChange?.(true);
  }), [activeSessionId, activeTemplateId, load, onHistoryAvailabilityChange, scope]);

  const copyResponse = useCallback(async (id: string, content: string) => {
    if (await window.clipboardApi.writeText(content)) {
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((current) => current === id ? undefined : current), 1600);
    }
  }, []);

  const visibleResponses = runs.reduce((count, run) => count + run.responses.length, 0);

  return (
    <section className="agent-output-panel" aria-label={t("agentOutput.title")}>
      <header className="agent-output-header">
        <div>
          <History aria-hidden="true" />
          <strong>{t("agentOutput.title")}</strong>
        </div>
        <span>{t("agentOutput.responseCount", { count: visibleResponses })}</span>
      </header>

      <div className="agent-output-scope" role="tablist" aria-label={t("agentOutput.scope")}>
        <button type="button" role="tab" aria-selected={scope === "current"} className={scope === "current" ? "active" : ""} onClick={() => setScope("current")}>
          {t("agentOutput.current")}
        </button>
        <button type="button" role="tab" aria-selected={scope === "all"} className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>
          {t("agentOutput.all")}
        </button>
      </div>

      <div className="agent-output-list">
        {loading ? (
          <div className="agent-output-state"><LoaderCircle className="spin" aria-hidden="true" />{t("common.loading")}</div>
        ) : error ? (
          <div className="agent-output-state error">
            <p>{t("agentOutput.loadFailed")}</p>
            <code>{error}</code>
            <button type="button" onClick={() => void load(false)}>{t("common.retry")}</button>
          </div>
        ) : runs.length === 0 || visibleResponses === 0 ? (
          <div className="agent-output-state">
            <p>{scope === "current" ? t("agentOutput.emptyCurrent") : t("agentOutput.emptyAll")}</p>
            <span>{t("agentOutput.hookRequired")}</span>
          </div>
        ) : runs.map((run, runIndex) => (
          <details className="agent-output-run" key={run.id} open={scope === "current" || runIndex === 0}>
            <summary>
              <span>
                <strong>{run.title || getAgentProviderLabel(run.provider)}</strong>
                <small>{getAgentProviderLabel(run.provider)} · {new Date(run.startedAt).toLocaleString()}</small>
              </span>
              <span>{run.responses.length}</span>
            </summary>
            {run.cwd && <div className="agent-output-cwd" title={run.cwd}>{run.cwd}</div>}
            {run.responsesTruncated && <div className="agent-output-truncated">{t("agentOutput.historyTruncated")}</div>}
            <div className="agent-output-responses">
              {run.responses.map((response) => (
                <article className="agent-output-response" key={response.id}>
                  <header>
                    <span className={`agent-output-phase ${response.phase}`}>
                      {t(response.phase === "commentary" ? "agentOutput.commentary" : "agentOutput.final")}
                    </span>
                    <time>{new Date(response.createdAt).toLocaleString()}</time>
                    <button type="button" title={t("agentOutput.copy")} aria-label={t("agentOutput.copy")} onClick={() => void copyResponse(response.id, response.content)}>
                      {copiedId === response.id ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
                    </button>
                  </header>
                  <MarkdownBlock className="agent-output-markdown" content={response.content} externalLinks />
                  {response.truncated && <footer>{t("agentOutput.responseTruncated")}</footer>}
                </article>
              ))}
            </div>
          </details>
        ))}
        {!loading && !error && runs.length < total && (
          <button className="agent-output-load-more" type="button" disabled={loadingMore} onClick={() => void load(true)}>
            {loadingMore ? t("common.loading") : t("agentOutput.loadMore")}
          </button>
        )}
      </div>
    </section>
  );
}
