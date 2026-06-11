import { useEffect, useState } from "react";
import type { RemoteSystemMetrics, TerminalSession } from "../vite-env";

type RemoteSystemMetricsState =
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "ready"; metrics: RemoteSystemMetrics }
  | { status: "error" };

const REFRESH_INTERVAL_MS = 3000;

export function useRemoteSystemMetrics(session?: TerminalSession): RemoteSystemMetricsState {
  const [state, setState] = useState<RemoteSystemMetricsState>({ status: "hidden" });

  useEffect(() => {
    if (!session || session.type !== "ssh") {
      setState({ status: "hidden" });
      return undefined;
    }

    let disposed = false;
    let timeoutId: number | undefined;
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
      if (typeof timeoutId === "number") window.clearTimeout(timeoutId);
    };
  }, [session?.id, session?.type]);

  return state;
}
