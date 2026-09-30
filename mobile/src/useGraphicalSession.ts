import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createRequestId } from "./protocol";
import { canSwitchMode, modelOptions, openCodePlanReplyId, permissions } from "./GraphicalPresentation";
import { PROTOCOL_VERSION, type AgentProvider, type ClientMessage, type GraphicalSnapshot,
  type GraphicalHistory, type QuickCommand, type RuntimeSession, type ServerMessage } from "./types";

type GraphicalMessage = Extract<ServerMessage,
  { type: "graphical.snapshot" | "graphical.delta" | "graphical.usage" | "graphical.history" | "graphical.upload.ready" | "command.ok" | "error" }>;
export type GraphicalViewProps = {
  session: RuntimeSession;
  connectionEpoch: number;
  send: (message: ClientMessage) => boolean;
  onGraphicalMessage: (listener: (message: GraphicalMessage) => void) => () => void;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  submissionPending: boolean;
  onSubmitRequest: (requestId: string) => void;
};

type ActionSheet = "menu" | "agent" | "agent-confirm" | "model" | "history" | "permission" | "native-mode" | null;
export function useGraphicalSession({ session, connectionEpoch, send, onGraphicalMessage, draft, setDraft, submissionPending, onSubmitRequest }: GraphicalViewProps) {
  const [snapshot, setSnapshot] = useState<GraphicalSnapshot | null>(null);
  const snapshotRef = useRef<GraphicalSnapshot | null>(null);
  const [sending, setSending] = useState(false);
  const setDraftRef = useRef(setDraft);
  setDraftRef.current = setDraft;
  const isSending = sending || submissionPending;
  const [error, setError] = useState("");
  const [activeSheet, setActiveSheet] = useState<ActionSheet>(null);
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider | null>(null);
  const [history, setHistory] = useState<GraphicalHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyMutation, setHistoryMutation] = useState<string | null>(null);
  const historyMutationRef = useRef<{ requestId: string; kind: "fork" | "delete"; threadId: string | null } | null>(null);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const pendingRef = useRef(new Set<string>());
  const submitIdRef = useRef<string | null>(null);
  const quickIdRef = useRef<string | null>(null);
  const quickDraftRef = useRef("");
  const historyIdRef = useRef<string | null>(null);
  const modeIdRef = useRef<string | null>(null);
  const [changingMode, setChangingMode] = useState(false);
  const [changingModel, setChangingModel] = useState(false);
  const modelIdRef = useRef<string | null>(null);
  const uploadRequests = useRef(new Map<string, { resolve: (value: { fileId: string; url: string }) => void; reject: (reason: Error) => void }>());
  const cancelledUploads = useRef(new Set<string>());
  const [attachments, setAttachments] = useState<Array<{ key: string; file: File; fileId?: string; status: "uploading" | "ready" | "failed" }>>([]);
  const attachmentsRef = useRef<typeof attachments>([]);
  const switchIdRef = useRef<string | null>(null);
  const subscribedEpochRef = useRef(0);
  const [switchingTo, setSwitchingTo] = useState<AgentProvider | null>(null);
  const threadRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    snapshotRef.current = null;
    setSnapshot(null);
    setHistory(null);
    setHistoryMutation(null);
    historyMutationRef.current = null;
    setActiveSheet(null);
    setSelectedProvider(null);
    setError("");
    setSending(false);
    setChangingMode(false);
    setChangingModel(false);
    setAttachments([]);
    setSwitchingTo(null);
    setExpandedGroupId(null);
    pendingRef.current.clear();
    modeIdRef.current = null;
    quickIdRef.current = null;
    quickDraftRef.current = "";
    modelIdRef.current = null;
    switchIdRef.current = null;
    threadRef.current = null;
    const unsubscribe = onGraphicalMessage(message => {
      if (message.type === "graphical.snapshot" && message.sessionId === session.id) {
        if (threadRef.current !== message.snapshot.threadId) {
          if (quickIdRef.current) pendingRef.current.delete(quickIdRef.current);
          quickIdRef.current = null;
          quickDraftRef.current = "";
          setSending(false);
          for (const item of attachmentsRef.current) cancelledUploads.current.add(item.key);
          const fileIds = attachmentsRef.current.flatMap(item => item.fileId ? [item.fileId] : []);
          if (fileIds.length) send({ v: PROTOCOL_VERSION, type: "graphical.upload.discard", sessionId: session.id,
            threadId: threadRef.current, fileIds, requestId: createRequestId() });
          setHistory(null);
          setActiveSheet(null);
          setSelectedProvider(null);
          setExpandedGroupId(null);
          setAttachments([]);
        }
        threadRef.current = message.snapshot.threadId;
        snapshotRef.current = message.snapshot;
        setSnapshot(message.snapshot);
      } else if (message.type === "graphical.delta" && message.sessionId === session.id) {
        const current = snapshotRef.current;
        if (current?.streamId === message.streamId && (current.revision ?? -1) >= message.revision) {
          return;
        }
        if (!current || current.streamId !== message.streamId || current.threadId !== message.threadId
          || current.revision !== message.baseRevision) {
          send({ v: PROTOCOL_VERSION, type: "graphical.subscribe", sessionId: session.id, delta: true });
        } else {
          const items = [...current.items];
          for (const text of message.textDeltas) {
            const index = items.findIndex(value => value.id === text.itemId);
            if (index >= 0) items[index] = { ...items[index], text: (items[index].text || "") + text.delta };
          }
          for (const item of message.items) {
            const index = items.findIndex(value => value.id === item.id);
            if (index < 0) items.push(item); else items[index] = item;
          }
          const next = { ...current, revision: message.revision, items };
          snapshotRef.current = next;
          setSnapshot(next);
        }
      } else if (message.type === "graphical.history" && message.sessionId === session.id
        && message.requestId === historyIdRef.current && message.threadId === threadRef.current) {
        pendingRef.current.delete(message.requestId);
        setHistory(current => current && current.nextCursor && current.nextCursor !== message.history.nextCursor
          ? { data: [...current.data, ...message.history.data], nextCursor: message.history.nextCursor }
          : message.history);
        setHistoryLoading(false);
      } else if (message.type === "graphical.upload.ready") {
        const pending = uploadRequests.current.get(message.requestId);
        if (pending) { uploadRequests.current.delete(message.requestId); pending.resolve({ fileId: message.fileId, url: message.url }); }
      } else if (message.type === "command.ok" && pendingRef.current.delete(message.requestId)) {
        const mutation = historyMutationRef.current;
        if (mutation?.requestId === message.requestId) {
          historyMutationRef.current = null;
          setHistoryMutation(null);
          if (message.sessionId !== session.id || message.threadId !== threadRef.current) return;
          if (mutation.kind === "fork") { setDraftRef.current(""); setActiveSheet(null); }
          else {
            setHistory(null); setHistoryLoading(true);
            const requestId = createRequestId();
            historyIdRef.current = requestId;
            pendingRef.current.add(requestId);
            if (!send({ v: PROTOCOL_VERSION, type: "graphical.history", sessionId: session.id,
              threadId: threadRef.current, requestId })) {
              pendingRef.current.delete(requestId); setHistoryLoading(false);
              setError("删除已成功，连接中断，请重新加载历史。");
              return;
            }
          }
        }
        if (submitIdRef.current === message.requestId) { setAttachments([]); setSending(false); submitIdRef.current = null; }
        if (quickIdRef.current === message.requestId) {
          const quickDraft = quickDraftRef.current;
          if (quickDraft) setDraftRef.current(current => current + quickDraft);
          quickDraftRef.current = "";
          quickIdRef.current = null;
          setSending(false);
        }
        if (modeIdRef.current === message.requestId) {
          setChangingMode(false); modeIdRef.current = null;
          setActiveSheet(current => current === "permission" || current === "native-mode" ? null : current);
        }
        if (modelIdRef.current === message.requestId) { setChangingModel(false); modelIdRef.current = null; }
        setError("");
      } else if (message.type === "error" && message.requestId && pendingRef.current.delete(message.requestId)) {
        const mutation = historyMutationRef.current;
        if (mutation?.requestId === message.requestId) {
          historyMutationRef.current = null; setHistoryMutation(null);
          if (mutation.threadId !== threadRef.current) return;
        }
        const upload = uploadRequests.current.get(message.requestId);
        if (upload) { uploadRequests.current.delete(message.requestId); upload.reject(new Error(message.message)); }
        setError(message.message);
        if (submitIdRef.current === message.requestId) { setSending(false); submitIdRef.current = null; }
        if (quickIdRef.current === message.requestId) { setSending(false); quickIdRef.current = null; quickDraftRef.current = ""; }
        if (modeIdRef.current === message.requestId) { setChangingMode(false); modeIdRef.current = null; }
        if (modelIdRef.current === message.requestId) { setChangingModel(false); modelIdRef.current = null; }
        if (switchIdRef.current === message.requestId) { setSwitchingTo(null); switchIdRef.current = null; }
        if (historyIdRef.current === message.requestId) setHistoryLoading(false);
      }
    });
    return () => {
      unsubscribe();
      for (const item of attachmentsRef.current) cancelledUploads.current.add(item.key);
      const fileIds = attachmentsRef.current.flatMap(item => item.fileId ? [item.fileId] : []);
      if (fileIds.length) send({ v: PROTOCOL_VERSION, type: "graphical.upload.discard", sessionId: session.id,
        threadId: threadRef.current, fileIds, requestId: createRequestId() });
      for (const pending of uploadRequests.current.values()) pending.reject(new Error("会话已切换。"));
      uploadRequests.current.clear();
    };
  }, [session.id, send, onGraphicalMessage]);

  useEffect(() => {
    if (!connectionEpoch) return;
    if (subscribedEpochRef.current && subscribedEpochRef.current !== connectionEpoch) {
      if (pendingRef.current.size || uploadRequests.current.size) setError("连接中断，操作结果未确认；请核对会话内容后再重试。");
      pendingRef.current.clear();
      submitIdRef.current = null;
      quickIdRef.current = null;
      quickDraftRef.current = "";
      modeIdRef.current = null;
      modelIdRef.current = null;
      switchIdRef.current = null;
      historyIdRef.current = null;
      historyMutationRef.current = null;
      setHistoryMutation(null);
      setSending(false);
      setChangingMode(false);
      setChangingModel(false);
      setSwitchingTo(null);
      setHistoryLoading(false);
      for (const item of attachmentsRef.current) cancelledUploads.current.add(item.key);
      for (const pending of uploadRequests.current.values()) pending.reject(new Error("连接已断开，请重新上传。"));
      uploadRequests.current.clear();
      setAttachments(current => current.map(item => ({ ...item, fileId: undefined, status: "failed" })));
    }
    subscribedEpochRef.current = connectionEpoch;
    send({ v: PROTOCOL_VERSION, type: "graphical.subscribe", sessionId: session.id, delta: true });
  }, [connectionEpoch, send, session.id]);

  const lastItem = snapshot?.items.at(-1);
  useEffect(() => { scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight }); }, [snapshot?.items.length, lastItem?.text, lastItem?.output]);

  useEffect(() => {
    if (!activeSheet) return;
    sheetRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveSheet(null);
      if (event.key !== "Tab" || !sheetRef.current) return;
      const elements = [...sheetRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
      const first = elements[0], last = elements.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === sheetRef.current)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); moreButtonRef.current?.focus(); };
  }, [activeSheet]);

  const action = (payload: { type: `graphical.${string}`; [key: string]: unknown }) => {
    if (!snapshot) return;
    if (historyMutationRef.current && ["graphical.submit", "graphical.new-thread", "graphical.resume",
      "graphical.model", "graphical.mode", "graphical.native-mode", "graphical.plan"].includes(payload.type)) return;
    const id = createRequestId();
    const message = { v: PROTOCOL_VERSION, sessionId: session.id, threadId: snapshot.threadId,
      requestId: id, ...payload } as ClientMessage;
    if (!send(message)) { setError("连接已断开，请重试。"); return; }
    pendingRef.current.add(id);
    return id;
  };

  const submit = () => {
    const text = draft.trim();
    const ready = attachments.filter(item => item.status === "ready" && item.fileId);
    if ((!text && !ready.length) || attachments.some(item => item.status !== "ready") || !snapshot?.threadId || isSending || historyMutationRef.current) return;
    submitIdRef.current = action({ type: "graphical.submit", text, fileIds: ready.map(item => item.fileId) }) || null;
    if (submitIdRef.current) { onSubmitRequest(submitIdRef.current); setSending(true); }
  };
  const runQuickCommand = (command: QuickCommand) => {
    if (!snapshot?.threadId || snapshot.archived) return false;
    if ((command.mode || "write") === "write") { setDraft(current => current + command.command); return true; }
    if (isSending || quickIdRef.current || historyMutationRef.current) return false;
    const id = createRequestId();
    if (!send({ v: PROTOCOL_VERSION, type: "quick-command.invoke", sessionId: session.id,
      commandId: command.id, threadId: snapshot.threadId, requestId: id })) {
      setError("连接已断开，请重试。");
      return false;
    }
    pendingRef.current.add(id);
    quickIdRef.current = id;
    quickDraftRef.current = command.mode === "one-time" ? command.command : "";
    setSending(true);
    return true;
  };
  const changeModel = (modelId: string) => {
    if (!snapshot || snapshot.busy || snapshot.archived || changingModel || attachments.length || !modelOptions(snapshot).some(option => option.value === modelId)) return;
    modelIdRef.current = action({ type: "graphical.model", modelId }) || null;
    if (modelIdRef.current) { setChangingModel(true); setActiveSheet(null); }
  };
  const uploadFile = async (file: File, key: string) => {
    if (!snapshot?.threadId) return;
    const requestId = createRequestId();
    const prepared = new Promise<{ fileId: string; url: string }>((resolve, reject) => uploadRequests.current.set(requestId, { resolve, reject }));
    pendingRef.current.add(requestId);
    if (!send({ v: PROTOCOL_VERSION, type: "graphical.upload.prepare", sessionId: session.id,
      threadId: snapshot.threadId, name: file.name, size: file.size, requestId })) {
      uploadRequests.current.delete(requestId); pendingRef.current.delete(requestId);
      setAttachments(current => current.map(item => item.key === key ? { ...item, status: "failed" } : item));
      setError("连接已断开，请重试。");
      return;
    }
    let uploadedId: string | null = null;
    try {
      const { fileId, url } = await prepared;
      uploadedId = fileId;
      pendingRef.current.delete(requestId);
      const response = await fetch(url, { method: "POST", body: file, cache: "no-store" });
      if (!response.ok) throw new Error("附件上传失败，请重试。");
      if (threadRef.current !== snapshot.threadId || cancelledUploads.current.has(key)) {
        send({ v: PROTOCOL_VERSION, type: "graphical.upload.discard", sessionId: session.id,
          threadId: snapshot.threadId, fileIds: [fileId], requestId: createRequestId() });
        return;
      }
      setAttachments(current => current.map(item => item.key === key ? { ...item, fileId, status: "ready" } : item));
    } catch (cause) {
      if (uploadedId) send({ v: PROTOCOL_VERSION, type: "graphical.upload.discard", sessionId: session.id,
        threadId: snapshot.threadId, fileIds: [uploadedId], requestId: createRequestId() });
      setAttachments(current => current.map(item => item.key === key ? { ...item, status: "failed" } : item));
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const chosen = [...files].slice(0, Math.max(0, 10 - attachments.length));
    if (chosen.length < files.length) setError("最多附加 10 个文件。");
    for (const file of chosen) {
      if (file.size > 10 * 1024 * 1024) { setError("单个附件必须在 10 MB 以内。"); continue; }
      const key = createRequestId();
      setAttachments(current => [...current, { key, file, status: "uploading" }]);
      void uploadFile(file, key);
    }
  };
  const removeAttachment = (key: string) => {
    cancelledUploads.current.add(key);
    const item = attachments.find(value => value.key === key);
    if (item?.fileId) action({ type: "graphical.upload.discard", fileIds: [item.fileId] });
    setAttachments(current => current.filter(value => value.key !== key));
  };
  const changeMode = (mode: "default" | "plan") => {
    if (!snapshot || snapshot.busy || snapshot.archived || changingMode || snapshot.pendingPlan || !canSwitchMode(snapshot, mode)) return;
    if (snapshot.provider === "codebuddy" ? mode === "plan" ? snapshot.mode === "plan"
      : snapshot.executionPermission === "fullAccess" : snapshot.mode === mode) return;
    modeIdRef.current = action({ type: "graphical.mode", mode }) || null;
    if (modeIdRef.current) setChangingMode(true);
  };
  const changePermission = (permission: typeof permissions[number]["value"]) => {
    if (!snapshot || snapshot.provider !== "codex" || !snapshot.threadId || snapshot.busy || snapshot.archived || changingMode
      || snapshot.capabilities?.permissions === false
      || snapshot.executionPermission === permission || snapshot.capabilities?.supportedPermissions && !snapshot.capabilities.supportedPermissions.includes(permission)) return;
    setError("");
    modeIdRef.current = action({ type: "graphical.permission", permission }) || null;
    if (modeIdRef.current) setChangingMode(true);
  };
  const changeNativeMode = (modeId: string) => {
    if (!snapshot || snapshot.provider === "codex" || !snapshot.threadId || snapshot.busy || snapshot.archived || changingMode
      || snapshot.nativeMode === modeId || !snapshot.nativeModes?.some(mode => mode.id === modeId)) return;
    setError("");
    modeIdRef.current = action({ type: "graphical.native-mode", modeId }) || null;
    if (modeIdRef.current) setChangingMode(true);
  };
  const executeOpenCodePlan = (itemId: string) => {
    if (!snapshot || changingMode || modeIdRef.current || openCodePlanReplyId(snapshot) !== itemId) return;
    setError("");
    modeIdRef.current = action({ type: "graphical.plan", itemId, execute: true }) || null;
    if (modeIdRef.current) setChangingMode(true);
  };
  const switchAgent = (provider: AgentProvider) => {
    if (historyMutationRef.current) return;
    if (!snapshot || snapshot.busy || snapshot.approvals.length || snapshot.questions.length || snapshot.pendingPlan || switchingTo
      || provider === snapshot.provider) return;
    const id = createRequestId();
    if (!send({ v: PROTOCOL_VERSION, type: "session.switch-agent", sessionId: session.id,
      threadId: snapshot.threadId, provider, requestId: id })) {
      setError("连接已断开，请重试。");
      return;
    }
    pendingRef.current.add(id);
    switchIdRef.current = id;
    setError("");
    setSwitchingTo(provider);
    setActiveSheet(null);
    setSelectedProvider(null);
  };
  const loadHistory = (cursor: string | null = null) => {
    if (!snapshot) return;
    setHistoryLoading(true);
    if (!cursor) setHistory(null);
    historyIdRef.current = action({ type: "graphical.history", cursor }) || null;
    if (!historyIdRef.current) setHistoryLoading(false);
  };

  const openHistory = () => { setActiveSheet("history"); loadHistory(); };
  const mutateHistory = (targetThreadId: string, kind: "fork" | "delete") => {
    if (!snapshot || snapshot.provider !== "opencode" || snapshot.busy || isSending || historyMutationRef.current
      || snapshot.pendingPlan || snapshot.approvals.length || snapshot.questions.length || attachments.some(item => item.status === "uploading")) return;
    const thread = history?.data.find(value => value.id === targetThreadId);
    if (!thread || !snapshot.capabilities?.[kind === "fork" ? "forkHistory" : "deleteHistory"]) return;
    if (kind === "delete" && (targetThreadId === snapshot.threadId
      || !window.confirm(`删除“${thread.title}”的历史记录？删除后无法在本工具中恢复。`))) return;
    setError("");
    const requestId = action({ type: kind === "fork" ? "graphical.fork" : "graphical.delete", targetThreadId });
    if (requestId) {
      historyMutationRef.current = { requestId, kind, threadId: snapshot.threadId };
      setHistoryMutation(targetThreadId);
    }
  };

  return { snapshot, isSending: isSending || Boolean(historyMutation), error, setError, activeSheet, setActiveSheet, selectedProvider, setSelectedProvider,
    history, historyLoading, historyMutation, mutateHistory, expandedGroupId, setExpandedGroupId, changingMode, changingModel,
    attachments, setAttachments, switchingTo, scrollRef, moreButtonRef, sheetRef, action, submit,
    runQuickCommand, changeModel, uploadFile, addFiles, removeAttachment, changeMode, changePermission,
    changeNativeMode, executeOpenCodePlan, switchAgent, loadHistory, openHistory };
}
