import { useEffect, useState } from "react";
import { normalizeGraphicalMenuConfig, type GraphicalMenuConfig } from "./graphicalMenu";

export function useGraphicalMenuConfig() {
  const [config, setConfig] = useState<GraphicalMenuConfig>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    let receivedUpdate = false;
    const unsubscribe = window.terminalApi?.onGraphicalMenuConfigChanged?.(value => {
      receivedUpdate = true;
      if (active) { setConfig(normalizeGraphicalMenuConfig(value)); setLoading(false); setError(""); }
    });
    void Promise.resolve().then(() => window.terminalApi.getConfig()).then(value => {
      if (active && !receivedUpdate) setConfig(normalizeGraphicalMenuConfig(value?.graphicalMenuSecondaryActions));
    }).catch(cause => {
      if (active && !receivedUpdate) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; unsubscribe?.(); };
  }, []);
  return { config, setConfig, error, loading };
}
