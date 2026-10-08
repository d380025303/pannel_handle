import { useEffect, useState } from "react";
import type { CodexAppServerSnapshot } from "../../vite-env";

export function OpenCodeRetryStatus({ retry, className }: {
  retry: CodexAppServerSnapshot["openCodeRetry"]; className?: string;
}) {
  const [now, setNow] = useState(Date.now);
  const next = retry?.nextRetryAt ? Date.parse(retry.nextRetryAt) : NaN;
  useEffect(() => {
    setNow(Date.now());
    if (!Number.isFinite(next)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [next]);
  if (!retry) return null;
  return <div className={className} role="status">
    模型调用失败，等待第 {retry.attempt} 次自动重试
    {Number.isFinite(next) && (next > now ? ` · 预计 ${new Date(next).toLocaleTimeString()}` : " · 等待 OpenCode 重试")}
    {retry.error.status && ` · HTTP ${retry.error.status}`}
    {(retry.error.message || retry.error.type) && ` · ${retry.error.message || retry.error.type}`}
  </div>;
}
