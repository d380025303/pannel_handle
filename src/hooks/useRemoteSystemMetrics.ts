import { useEffect, useRef, useState } from "react";
import type { RemoteSystemMetrics, TerminalSession } from "../vite-env";

export type RemoteSystemMetricPoint = {
  sampledAt: number;
  cpuUsedPercent: number | null;
  memoryUsedPercent: number | null;
  receivedBytesPerSecond: number | null;
  transmittedBytesPerSecond: number | null;
};

export type RemoteSystemMetricsState =
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "ready"; metrics: RemoteSystemMetrics; history: RemoteSystemMetricPoint[] }
  | { status: "error" };

const REFRESH_INTERVAL_MS = 3000;
const HISTORY_WINDOW_MS = 5 * 60 * 1000;
const MAX_HISTORY_POINTS = Math.ceil(HISTORY_WINDOW_MS / REFRESH_INTERVAL_MS) + 1;

function percent(value: number | null) {
  return value !== null && Number.isFinite(value) && value >= 0 ? Math.min(100, value) : null;
}

function toHistoryPoint(metrics: RemoteSystemMetrics): RemoteSystemMetricPoint {
  const { usedBytes, totalBytes } = metrics.memory;
  return {
    sampledAt: metrics.sampledAt,
    cpuUsedPercent: percent(metrics.cpu.usedPercent),
    memoryUsedPercent: Number.isFinite(usedBytes) && usedBytes >= 0
      && Number.isFinite(totalBytes) && totalBytes > 0
      ? percent(usedBytes / totalBytes * 100)
      : null,
    receivedBytesPerSecond: Number.isFinite(metrics.network.receivedBytesPerSecond)
      && metrics.network.receivedBytesPerSecond !== null && metrics.network.receivedBytesPerSecond >= 0
      ? metrics.network.receivedBytesPerSecond
      : null,
    transmittedBytesPerSecond: Number.isFinite(metrics.network.transmittedBytesPerSecond)
      && metrics.network.transmittedBytesPerSecond !== null && metrics.network.transmittedBytesPerSecond >= 0
      ? metrics.network.transmittedBytesPerSecond
      : null
  };
}

function appendHistory(history: RemoteSystemMetricPoint[], metrics: RemoteSystemMetrics) {
  const next = [...history.filter((point) => point.sampledAt !== metrics.sampledAt), toHistoryPoint(metrics)]
    .sort((left, right) => left.sampledAt - right.sampledAt);
  const latestSampledAt = next[next.length - 1].sampledAt;
  return next
    .filter((point) => point.sampledAt >= latestSampledAt - HISTORY_WINDOW_MS)
    .slice(-MAX_HISTORY_POINTS);
}

export function useRemoteSystemMetrics(
  session?: TerminalSession,
  runningSessionIds: readonly string[] = session ? [session.id] : []
): RemoteSystemMetricsState {
  const [result, setResult] = useState<{ sessionId?: string; state: RemoteSystemMetricsState }>({ state: { status: "hidden" } });
  const historyBySessionRef = useRef(new Map<string, RemoteSystemMetricPoint[]>());
  const runningSessionIdsKey = runningSessionIds.join("\0");

  useEffect(() => {
    const runningIds = new Set(runningSessionIdsKey ? runningSessionIdsKey.split("\0") : []);
    for (const sessionId of historyBySessionRef.current.keys()) {
      if (!runningIds.has(sessionId)) historyBySessionRef.current.delete(sessionId);
    }
  }, [runningSessionIdsKey]);

  useEffect(() => {
    if (!session || session.type !== "ssh") {
      setResult({ state: { status: "hidden" } });
      return undefined;
    }

    let disposed = false;
    let timeoutId: number | undefined;
    const setState = (state: RemoteSystemMetricsState) => setResult({ sessionId: session.id, state });
    setState({ status: "loading" });

    const poll = async () => {
      try {
        const metrics = await window.remoteSystemApi.getMetrics(session.id);
        if (!disposed) {
          const history = appendHistory(historyBySessionRef.current.get(session.id) ?? [], metrics);
          historyBySessionRef.current.set(session.id, history);
          setState({ status: "ready", metrics, history });
        }
      } catch {
        if (!disposed) setState({ status: "error" });
      }
      if (!disposed) {
        timeoutId = window.setTimeout(poll, REFRESH_INTERVAL_MS);
      }
    };

    void poll();
    return () => {
      disposed = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [session?.id, session?.type]);

  if (!session || session.type !== "ssh") return { status: "hidden" };
  return result.sessionId === session.id ? result.state : { status: "loading" };
}
