import { useEffect, useRef, useState } from "react";
import { createRequestId } from "./protocol";
import { GraphicalIcon } from "./GraphicalIcon";
import { PROTOCOL_VERSION, type ClientMessage, type GraphicalSnapshot, type GraphicalUsage, type ServerMessage } from "./types";

type GraphicalMessage = Extract<ServerMessage,
  { type: "graphical.snapshot" | "graphical.usage" | "graphical.history" | "graphical.upload.ready" | "command.ok" | "error" }>;
type Props = {
  sessionId: string;
  sessionType: "windows" | "wsl" | "ssh";
  snapshot: GraphicalSnapshot;
  send: (message: ClientMessage) => boolean;
  onGraphicalMessage: (listener: (message: GraphicalMessage) => void) => () => void;
};

function amount(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function time(value: number) {
  return Number.isFinite(value) ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未知";
}

export function GraphicalUsage({ sessionId, sessionType, snapshot, send, onGraphicalMessage }: Props) {
  const [usage, setUsage] = useState<GraphicalUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const requestRef = useRef<string | null>(null);
  const loadRef = useRef<(force: boolean) => void>(() => {});
  const threadId = snapshot.threadId;
  const provider = snapshot.provider;
  const backend = snapshot.backend;
  const supported = provider === "codebuddy" || (provider === "qoder" || provider === "gemini") && sessionType !== "ssh" || (provider === "codex" && backend !== "openrouter" && backend !== "nararouter");

  useEffect(() => {
    if (!supported) return;
    let timeout: number | undefined;
    setUsage(null);
    setError("");
    setLoading(true);
    setOpen(false);
    const load = (force: boolean) => {
      const requestId = createRequestId();
      requestRef.current = requestId;
      setLoading(true);
      setError("");
      window.clearTimeout(timeout);
      if (!send({ v: PROTOCOL_VERSION, type: "graphical.usage", sessionId, threadId, force, requestId })) {
        requestRef.current = null;
        setLoading(false);
        setError("连接已断开，请重试。");
        return;
      }
      timeout = window.setTimeout(() => {
        if (requestRef.current !== requestId) return;
        requestRef.current = null;
        setLoading(false);
        setError("额度查询超时，请重试。");
      }, 15_000);
    };
    loadRef.current = load;
    const unsubscribe = onGraphicalMessage(message => {
      if (message.type !== "graphical.usage" && message.type !== "error") return;
      if (!message.requestId || message.requestId !== requestRef.current) return;
      if (message.type === "graphical.usage" && message.sessionId === sessionId && message.threadId === threadId) {
        requestRef.current = null;
        window.clearTimeout(timeout);
        setUsage(message.usage);
        setLoading(false);
        setError("");
      } else if (message.type === "error") {
        requestRef.current = null;
        window.clearTimeout(timeout);
        setLoading(false);
        setError(message.message || "额度暂不可用。");
      }
    });
    load(false);
    const interval = window.setInterval(() => load(false), provider === "codebuddy" || backend === "codebuddy" || backend === "minimax" ? 60_000 : 5 * 60_000);
    return () => {
      requestRef.current = null;
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      unsubscribe();
    };
  }, [backend, onGraphicalMessage, provider, send, sessionId, supported, threadId]);

  if (!supported) return null;
  const primary = usage?.limits.find(limit => limit.id === usage.primaryLimitId) || usage?.limits[0];
  const summary = usage?.summary;
  const label = summary?.kind === "credits" ? `剩余 ${amount(summary.remaining)} / ${amount(summary.total)} ${summary.unit}`
    : summary?.kind === "currency" ? `可用 ¥${amount(summary.available)}`
    : primary ? `${primary.name} 剩余 ${amount(primary.remainingPercent)}%` : loading ? "额度加载中…" : "额度暂不可用";
  return <div className="graphical-usage">
    <button type="button" className="graphical-usage-trigger" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="graphical-usage-trigger-label">额度 · {label}{error && usage ? " · 更新失败" : loading && usage ? " · 刷新中" : ""}</span><span className="graphical-usage-chevron"><GraphicalIcon name="chevron" /></span>
    </button>
    {open && <section className="graphical-usage-details" aria-label="额度详情">
      {usage?.summary?.kind === "credits" && <p className="graphical-usage-summary">总额 {amount(usage.summary.total)} · 已用 {amount(usage.summary.used)} · 剩余 {amount(usage.summary.remaining)} {usage.summary.unit}</p>}
      {usage?.summary?.kind === "currency" && <p className="graphical-usage-summary">可用 ¥{amount(usage.summary.available)} · 现金 ¥{amount(usage.summary.cash)} · 代金券 ¥{amount(usage.summary.voucher)} · 授信 ¥{amount(usage.summary.credit)} · 欠费 ¥{amount(usage.summary.owed)}</p>}
      {usage?.limits.map(limit => <div className="graphical-usage-limit" key={limit.id}>
        <div className="graphical-usage-limit-heading"><strong>{limit.name}</strong><span>{limit.unlimited ? "无限制" : `剩余 ${amount(limit.remainingPercent)}%`}</span></div>
        {!limit.unlimited && <progress max="100" value={limit.remainingPercent} aria-label={`${limit.name} 剩余额度`} />}
        {(limit.totalAmount !== undefined || limit.total !== undefined || limit.resetsAt || limit.expiresAt) && <div className="graphical-usage-limit-meta">
          {limit.totalAmount !== undefined && <small>剩余 {amount(limit.remainingAmount ?? 0)} / {amount(limit.totalAmount)} {limit.unit || ""}</small>}
          {limit.total !== undefined && <small>剩余 {amount(limit.remaining ?? 0)} / {amount(limit.total)}</small>}
          {limit.resetsAt && <small>重置时间：{time(limit.resetsAt)}</small>}
          {limit.expiresAt && <small>到期时间：{time(limit.expiresAt)}</small>}
        </div>}
      </div>)}
      {error && <p className="graphical-usage-error" role="alert">{error}</p>}
      {!usage && loading && <p className="graphical-usage-status" role="status">正在读取额度…</p>}
      <div className="graphical-usage-footer">
        <small>{usage ? `更新于 ${time(usage.fetchedAt)}` : ""}</small>
        <button type="button" className="graphical-usage-refresh graphical-icon-button" aria-label={loading ? "刷新中" : "刷新额度"} title="刷新额度" disabled={loading} onClick={() => loadRef.current(true)}>
          <GraphicalIcon name="refresh" />
        </button>
      </div>
    </section>}
  </div>;
}
