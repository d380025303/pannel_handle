import { useEffect, useState } from "react";
import type { RemoteSystemMetrics, TerminalSession } from "../vite-env";

export type RemoteSystemMetricsState =
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "ready"; metrics: RemoteSystemMetrics }
  | { status: "error" };

const REFRESH_INTERVAL_MS = 3000;

export function useRemoteSystemMetrics(session?: TerminalSession): RemoteSystemMetricsState {
  const [result, setResult] = useState<{ sessionId?: string; state: RemoteSystemMetricsState }>({ state: { status: "hidden" } });

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
        if (!disposed) setState({ status: "ready", metrics });
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
