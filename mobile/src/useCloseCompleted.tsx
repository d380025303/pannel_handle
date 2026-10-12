import { useEffect, useRef, useState } from "react";
import { createRequestId } from "./protocol";
import { PROTOCOL_VERSION } from "./types";
import type { useRemoteConnection } from "./useRemoteConnection";

export function useCloseCompleted(remote: ReturnType<typeof useRemoteConnection>) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const ids = remote.sessions.filter(session => remote.overviews[session.id]?.canCloseCompleted === true).map(session => session.id);
  const finish = (message: string) => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    setBusy(false);
    setNotice(message);
  };
  useEffect(() => remote.onSessionMessage(message => {
    if (!("requestId" in message) || message.requestId !== pending.current?.id) return;
    if (message.type === "sessions.close-completed.result")
      finish(`已关闭 ${message.closed}，跳过 ${message.skipped}，失败 ${message.failed}`);
    else if (message.type === "error") finish(message.message);
  }), [remote.onSessionMessage]);
  useEffect(() => {
    if (remote.status !== "connected" && pending.current) finish("连接已断开，请核对当前会话列表。");
  }, [remote.status, remote.connectionEpoch]);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current.timer); }, []);
  const close = () => {
    if (pending.current || remote.status !== "connected" || !ids.length) return;
    const id = createRequestId();
    pending.current = { id, timer: setTimeout(() => finish("关闭请求超时，请核对当前会话列表。"), 30_000) };
    setBusy(true);
    setNotice("");
    if (!remote.send({ v: PROTOCOL_VERSION, type: "sessions.close-completed", requestId: id, sessionIds: ids }))
      finish("无法发送关闭请求，请检查连接。");
  };
  return { busy, notice, count: ids.length, disabled: busy || !ids.length || remote.status !== "connected", close };
}

export function CloseCompletedAction({ controller }: { controller: ReturnType<typeof useCloseCompleted> }) {
  return <div className="mobile-close-completed">
    <button type="button" className="mobile-files-button" disabled={controller.disabled} onClick={controller.close}>
      {controller.busy ? "正在关闭…" : `关闭已完成（${controller.count}）`}
    </button>
    {controller.notice && <p role="status">{controller.notice}</p>}
  </div>;
}
