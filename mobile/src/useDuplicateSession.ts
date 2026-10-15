import { useEffect, useRef, useState } from "react";
import { createRequestId } from "./protocol";
import { PROTOCOL_VERSION } from "./types";
import type { useRemoteConnection } from "./useRemoteConnection";

export function useDuplicateSession(remote: ReturnType<typeof useRemoteConnection>) {
  const pending = useRef(new Map<string, string>());
  const [copyingIds, setCopyingIds] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  useEffect(() => {
    const unsubscribe = remote.onGraphicalMessage(message => {
      if (message.type !== "command.ok" && message.type !== "error") return;
      if (!message.requestId || !pending.current.delete(message.requestId)) return;
      setCopyingIds(new Set(pending.current.values()));
    });
    return () => { unsubscribe(); };
  }, [remote.onGraphicalMessage]);
  useEffect(() => {
    if (remote.status === "connected") return;
    pending.current.clear();
    setCopyingIds(new Set());
  }, [remote.status]);
  const copy = (sessionId: string) => {
    if (remote.status !== "connected" || [...pending.current.values()].includes(sessionId)) return;
    const requestId = createRequestId();
    pending.current.set(requestId, sessionId);
    setCopyingIds(new Set(pending.current.values()));
    setError("");
    if (!remote.send({ v: PROTOCOL_VERSION, type: "session.duplicate", sessionId, requestId })) {
      pending.current.delete(requestId);
      setCopyingIds(new Set(pending.current.values()));
      setError("复制请求未发送，请检查连接后重试。");
    }
  };
  return { copyingIds, error, copy };
}
