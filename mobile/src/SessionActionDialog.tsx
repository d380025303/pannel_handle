import { useCallback, useEffect, useRef, useState } from "react";
import { createRequestId } from "./protocol";
import { PROTOCOL_VERSION, type ClientMessage, type RuntimeSession } from "./types";

type SessionDialog = { type: "close"; session: RuntimeSession };

export function useSessionActionDialog(send: (message: ClientMessage) => boolean) {
  const [sessionDialog, setSessionDialog] = useState<SessionDialog | null>(null);
  const [dialogClosing, setDialogClosing] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);

  const dismiss = useCallback(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) setSessionDialog(null);
    else setDialogClosing(true);
  }, []);

  useEffect(() => {
    if (!sessionDialog) return;
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); dismiss(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const elements = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
      const first = elements[0], last = elements.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); dialogTriggerRef.current?.focus(); };
  }, [sessionDialog, dismiss]);

  useEffect(() => {
    if (!dialogClosing) return;
    const timeout = window.setTimeout(() => setSessionDialog(null), 240);
    return () => window.clearTimeout(timeout);
  }, [dialogClosing]);

  const open = (type: SessionDialog["type"], session: RuntimeSession, trigger: HTMLElement) => {
    dialogTriggerRef.current = trigger;
    setDialogClosing(false);
    setSessionDialog({ type, session });
  };

  const confirm = () => {
    if (!sessionDialog) return;
    send({ v: PROTOCOL_VERSION, type: "session.close", sessionId: sessionDialog.session.id, requestId: createRequestId() });
    dismiss();
  };

  return { sessionDialog, dialogClosing, dialogRef, open, dismiss, confirm };
}

export function SessionActionDialog({ dialog }: { dialog: ReturnType<typeof useSessionActionDialog> }) {
  const { sessionDialog, dialogClosing, dialogRef, dismiss, confirm } = dialog;
  if (!sessionDialog) return null;
  return <div className="session-dialog-backdrop" data-closing={dialogClosing} onClick={dismiss}>
    <div ref={dialogRef} className="session-dialog" role="dialog" aria-modal="true"
      aria-label="关闭会话" tabIndex={-1} onClick={event => event.stopPropagation()}>
      <h2>关闭会话</h2>
      <p>关闭“{sessionDialog.session.title}”会终止正在运行的会话，是否继续？</p>
      <div className="session-dialog-actions"><button type="button" onClick={dismiss}>取消</button>
        <button className="danger" type="button" onClick={confirm}>确认关闭</button></div>
    </div>
  </div>;
}
