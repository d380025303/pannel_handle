import { useEffect, useRef, useState } from "react";
import type { WorkItem, WorkItemApi, WorkItemAttempt } from "../../vite-env";

type Dialog = { id: string; kind: "detail" | "execute" | "attempts" | "void" | "restore" | "resolve" };

export function useWorkItemDialog(api: WorkItemApi, visible: boolean, reload: number) {
  const promptInitialized = useRef(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [item, setItem] = useState<WorkItem | null>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<WorkItemApi["preview"]>> | null>(null);
  const [dialogLoading, setDialogLoading] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [promptMode, setPromptMode] = useState<"preview" | "edit">("preview");
  const [reason, setReason] = useState("");
  const [attemptPage, setAttemptPage] = useState(0);
  const [attempts, setAttempts] = useState<Awaited<ReturnType<WorkItemApi["listAttempts"]>> | null>(null);
  const [selectedAttemptId, setSelectedAttemptId] = useState("");
  const [attempt, setAttempt] = useState<WorkItemAttempt | null>(null);

  useEffect(() => {
    if (!dialog || !visible) return;
    let live = true;
    setDialogLoading(true);
    void (async () => {
      const value = await api.get({ id: dialog.id });
      if (!live) return;
      setItem(value);
      if (dialog.kind === "execute" && !["creating", "running", "uncertain", "void"].includes(value.status)) {
        const initialPrompt = !promptInitialized.current
          ? [value.output, ...(await api.listQuickPrompts()).filter(record => record.persistent).map(record => record.prompt)].filter(Boolean).join("\n\n")
          : undefined;
        if (!live) return;
        const body = await api.preview({ id: value.id, version: value.version, ...(initialPrompt === undefined ? {} : { prompt: initialPrompt }) });
        if (!live) return;
        setPreview(body);
        if (initialPrompt !== undefined) { setPrompt(initialPrompt); promptInitialized.current = true; }
      }
      if (dialog.kind === "attempts") {
        const records = await api.listAttempts({ id: dialog.id, page: attemptPage });
        if (!live) return;
        setAttempts(records);
        if (selectedAttemptId) {
          const detail = await api.getAttempt({ id: dialog.id, attemptId: selectedAttemptId });
          if (live) setAttempt(detail);
        }
      }
    })().catch(err => { if (live) setDialogError(String(err)); }).finally(() => { if (live) setDialogLoading(false); });
    return () => { live = false; };
  }, [api, dialog, visible, reload, attemptPage, selectedAttemptId]);

  function open(id: string, kind: Dialog["kind"]) {
    promptInitialized.current = false; setPrompt(""); setPromptMode("preview");
    setItem(null); setPreview(null); setAttempts(null); setAttempt(null); setSelectedAttemptId(""); setAttemptPage(0);
    setDialogError(""); setReason(""); setDialog({ id, kind });
  }

  return {
    dialog, setDialog, item, setItem, preview, dialogLoading, dialogError, setDialogError,
    prompt, setPrompt, promptMode, setPromptMode, reason, setReason,
    attemptPage, setAttemptPage, attempts, selectedAttemptId, setSelectedAttemptId, attempt, setAttempt, open,
  };
}
