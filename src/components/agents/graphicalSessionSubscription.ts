import type { CodexAppServerSnapshot } from "../../vite-env";

type Callbacks = {
  onSnapshot: (snapshot: CodexAppServerSnapshot) => void;
  onError: (error: unknown) => void;
};

export function subscribeGraphicalSession(sessionId: string, { onSnapshot, onError }: Callbacks) {
  let active = true;
  let receivedChange = false;
  void window.codexAppServerApi.snapshot(sessionId).then(snapshot => {
    if (active && !receivedChange) onSnapshot(snapshot);
  }).catch(error => { if (active) onError(error); });
  const off = window.codexAppServerApi.onChanged(payload => {
    if (!active || payload.id !== sessionId) return;
    receivedChange = true;
    onSnapshot(payload.snapshot);
  });
  return () => { active = false; off(); };
}
