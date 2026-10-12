import { useRef, useState } from "react";
import type { WorkItem, WorkItemApi, WorkItemPage } from "../../vite-env";

type Operation = "execute" | "markCompleted" | "void" | "restore" | "resolveUncertain";
type Options = {
  api: WorkItemApi;
  item: WorkItem | null;
  dialog: { id: string } | null;
  prompt: string;
  reason: string;
  setItem: (item: WorkItem) => void;
  setError: (error: string) => void;
  setDialogError: (error: string) => void;
  refresh: () => void;
  onSuccess: (result: WorkItem, operation: Operation) => void;
};

export function useWorkItemActions({ api, item, dialog, prompt, reason, setItem, setError, setDialogError, refresh, onSuccess }: Options) {
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);

  async function perform(operation: Operation) {
    if (!item || submitting.current || (operation === "execute" && !prompt.trim())) return;
    submitting.current = true; setBusy(true); setDialogError("");
    try {
      const result = await api[operation]({ id: item.id, version: item.version, ...(operation === "void" ? { reason } : {}), ...(operation === "execute" ? { prompt } : {}) });
      onSuccess(result, operation);
    } catch (err) { setDialogError(String(err)); }
    finally { submitting.current = false; setBusy(false); refresh(); }
  }

  async function toggleFollowUp(value: WorkItem | WorkItemPage["records"][number]) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true);
    const reportError = dialog ? setDialogError : setError;
    reportError("");
    try {
      const updated = await api.setFollowUp({ id: value.id, version: value.version, needsFollowUp: !value.needsFollowUp });
      if (dialog?.id === updated.id) setItem(updated);
      refresh();
    } catch (err) { reportError(String(err)); }
    finally { submitting.current = false; setBusy(false); }
  }

  return { busy, perform, toggleFollowUp };
}
