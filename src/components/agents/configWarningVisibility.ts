import { useEffect, useState, useSyncExternalStore } from "react";

const closedEvents = new Set<string>();
const listeners = new Set<() => void>();
const ignoredByTemplate = new Map<string, string[]>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const notify = () => { for (const listener of listeners) listener(); };

export function configWarningFingerprint(payload: Record<string, unknown>) {
  return JSON.stringify([payload.summary ?? null, payload.details ?? null, payload.path ?? null]);
}

export function useConfigWarningVisibility(sessionId: string | undefined, templateId: string | undefined, eventId: string, fingerprint: string) {
  const key = JSON.stringify([sessionId, eventId]);
  const hidden = useSyncExternalStore(subscribe, () => closedEvents.has(key) || Boolean(templateId && ignoredByTemplate.get(templateId)?.includes(fingerprint)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!templateId) return;
    let cancelled = false;
    let changed = false;
    const api = window.terminalApi;
    const unsubscribe = api.onConfigWarningsChanged(({ templateId: id, ignored }) => {
      if (id !== templateId) return;
      changed = true;
      ignoredByTemplate.set(id, ignored);
      notify();
    });
    void api.getIgnoredConfigWarnings(templateId).then(ignored => {
      if (cancelled || changed) return;
      ignoredByTemplate.set(templateId, ignored);
      notify();
    }).catch(cause => { if (!cancelled) setError(`读取屏蔽记录失败：${cause instanceof Error ? cause.message : String(cause)}`); });
    return () => { cancelled = true; unsubscribe(); };
  }, [templateId]);
  const close = () => { closedEvents.add(key); notify(); };
  const ignore = async () => {
    if (!templateId || busy) return;
    setBusy(true);
    setError("");
    try {
      const ignored = await window.terminalApi.ignoreConfigWarning(templateId, fingerprint);
      ignoredByTemplate.set(templateId, ignored);
      notify();
    } catch (cause) {
      setError(`保存屏蔽记录失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally { setBusy(false); }
  };
  return { hidden, busy, error, close, ignore };
}
