import { useEffect, useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useI18n } from "../../i18n";
import type { RemoteAgentApprovalDecision, RemoteAgentApprovalRequest, TerminalSession } from "../../vite-env";

type RemoteAgentApprovalCardProps = {
  sessions: TerminalSession[];
};

function sortApprovals(approvals: RemoteAgentApprovalRequest[]) {
  return [...approvals].sort((left, right) => left.timestamp - right.timestamp);
}

export function RemoteAgentApprovalCard({ sessions }: RemoteAgentApprovalCardProps) {
  const { t } = useI18n();
  const [approvals, setApprovals] = useState<RemoteAgentApprovalRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const resolvedIds = new Set<string>();
    const removeRequested = window.remoteAgentApi.onApprovalRequested((request) => {
      if (disposed) return;
      resolvedIds.delete(request.id);
      setApprovals((current) => sortApprovals([
        ...current.filter((item) => item.id !== request.id),
        request
      ]));
    });
    const removeResolved = window.remoteAgentApi.onApprovalResolved(({ id }) => {
      resolvedIds.add(id);
      if (!disposed) setApprovals((current) => current.filter((item) => item.id !== id));
    });
    void window.remoteAgentApi.listPendingApprovals().then((pending) => {
      if (!disposed) setApprovals((current) => {
        const listed = pending.filter((item) => !resolvedIds.has(item.id));
        const listedIds = new Set(listed.map((item) => item.id));
        return sortApprovals([
          ...listed,
          ...current.filter((item) => !listedIds.has(item.id) && !resolvedIds.has(item.id))
        ]);
      });
    });
    return () => {
      disposed = true;
      removeRequested();
      removeResolved();
    };
  }, []);

  const current = approvals[0];
  const source = useMemo(() => {
    if (!current) return "";
    return sessions.find((session) => session.id === current.sessionId)?.title || current.sessionId;
  }, [current, sessions]);

  if (!current) return null;

  const decide = async (decision: RemoteAgentApprovalDecision) => {
    setBusyId(current.id);
    setError(null);
    try {
      const accepted = await window.remoteAgentApi.resolveApproval(current.id, decision);
      if (!accepted) {
        setApprovals(sortApprovals(await window.remoteAgentApi.listPendingApprovals()));
        setError(t("remoteAgent.approvalFailed"));
        return;
      }
      setApprovals((items) => items.filter((item) => item.id !== current.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("remoteAgent.approvalFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const busy = busyId === current.id;
  return (
    <section className="remote-agent-approval-card" role="region" aria-live="assertive" aria-label={t("remoteAgent.approvalTitle")}>
      <header>
        <ShieldAlert aria-hidden="true" />
        <div>
          <strong>{t("remoteAgent.approvalTitle")}</strong>
          <span>{t("remoteAgent.approvalSource", { source })}</span>
        </div>
        {approvals.length > 1 && <small>{t("remoteAgent.approvalRemaining", { count: approvals.length - 1 })}</small>}
      </header>
      <div className="remote-agent-approval-detail">
        <strong>{current.tool}</strong>
        <code>{current.summary}</code>
      </div>
      {error && <p className="remote-agent-approval-error">{error}</p>}
      <div className="remote-agent-approval-actions">
        <button type="button" disabled={busy} onClick={() => void decide("deny")}>{t("remoteAgent.approvalDeny")}</button>
        <button type="button" disabled={busy} onClick={() => void decide("once")}>{t("remoteAgent.approvalOnce")}</button>
        <button className="primary" type="button" disabled={busy} onClick={() => void decide("session")}>{t("remoteAgent.approvalSession")}</button>
      </div>
    </section>
  );
}
