import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkItemApi } from "../../src/vite-env";
import type { WorkItemOperation } from "./types";
import { createRequestId } from "./protocol";
import { WorkItemWorkspace } from "./WorkItemWorkspace";
import type { useRemoteConnection } from "./useRemoteConnection";

export function MobileWorkItems({ remote, onClose, onOpenSession }: {
  remote: ReturnType<typeof useRemoteConnection>; onClose: () => void; onOpenSession: (id: string) => void;
}) {
  const { send, onWorkItemMessage, connectionEpoch, status } = remote;
  const pending = useRef(new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  const listeners = useRef(new Set<() => void>());
  const connected = useRef(status === "connected");
  connected.current = status === "connected";
  const [notice, setNotice] = useState("");
  const api = useMemo(() => {
    const request = (operation: WorkItemOperation, input: unknown) => new Promise((resolve, reject) => {
      if (!connected.current) { reject(new Error("连接已断开，请重新连接后再试。")); return; }
      const requestId = createRequestId();
      const timer = setTimeout(() => {
        pending.current.delete(requestId);
        reject(new Error("请求超时，请刷新任务和执行记录核对结果；执行请求不会自动重发。"));
      }, 60000);
      pending.current.set(requestId, { resolve, reject, timer });
      if (!send({ v: 8, type: "work-items.request", operation, input, requestId })) {
        clearTimeout(timer); pending.current.delete(requestId); reject(new Error("连接已断开，请重新连接后核对任务结果。"));
      }
    });
    const operations: WorkItemOperation[] = ["list", "get", "preview", "execute", "setFollowUp", "listAttempts", "getAttempt", "void", "restore", "resolveUncertain"];
    return { ...Object.fromEntries(operations.map(operation => [operation, (input: unknown) => request(operation, input)])),
      onChanged: (listener: () => void) => { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; }
    } as WorkItemApi;
  }, [send]);
  useEffect(() => {
    const off = onWorkItemMessage(message => {
      if (message.type === "work-items.changed") { listeners.current.forEach(listener => listener()); return; }
      const request = message.requestId && pending.current.get(message.requestId);
      if (!request || !message.requestId) return;
      clearTimeout(request.timer); pending.current.delete(message.requestId);
      if (message.type === "error") request.reject(new Error(message.message));
      else request.resolve(message.result);
    });
    return () => {
      off();
      for (const request of pending.current.values()) { clearTimeout(request.timer); request.reject(new Error("任务页面已关闭，请核对执行结果。")); }
      pending.current.clear();
    };
  }, [onWorkItemMessage]);
  useEffect(() => {
    if (status !== "connected") {
      if (pending.current.size) setNotice("连接中断，请重连后核对任务和执行记录；请求不会自动重发。");
      for (const request of pending.current.values()) { clearTimeout(request.timer); request.reject(new Error("连接中断，请核对任务结果。")); }
      pending.current.clear();
    } else listeners.current.forEach(listener => listener());
  }, [status, connectionEpoch]);
  return <div className="mobile-work-items-page">
    <header><button type="button" onClick={onClose}>返回会话首页</button></header>
    {notice && <p role="status">{notice}</p>}
    <WorkItemWorkspace api={api} visible={status === "connected"} sessions={remote.sessions} onOpenSession={onOpenSession} />
  </div>;
}
