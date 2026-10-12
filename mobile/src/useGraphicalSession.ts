import { applySubAgentTextDeltas } from "../../src/utils/subAgentTextDeltas";
import { IMAGE_INPUT_UNSUPPORTED, isCodexImageFile, supportsCodexImageInput } from "../../src/utils/codexImageInput";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { CodexCapabilityReference } from "../../src/vite-env";
import { createRequestId } from "./protocol";
import { graphicalInputPolicy } from "./GraphicalInputPolicy";
import { codeBuddyMultitaskOption } from "./CodeBuddyOptions";
import { canSwitchMode, modelOptions, openCodeEffortOption, openCodePlanReplyId, permissions } from "./GraphicalPresentation";
import { PROTOCOL_VERSION, type AgentProvider, type ClientMessage, type GraphicalSnapshot,
  type OpenCodeCommand, type CodeBuddyCommand, type CodexCommand, type GraphicalHistory, type QuickCommand, type RuntimeSession, type ServerMessage } from "./types";

type GraphicalMessage = Extract<ServerMessage,
  { type: "graphical.snapshot" | "graphical.delta" | "graphical.usage" | "graphical.history" | "graphical.upload.ready" | "graphical.result" | "graphical.opencode.auth-data" | "graphical.opencode.auth-state" | "command.ok" | "error" }>;
export type GraphicalViewProps = {
  minimalMode?: boolean;
  graphicalMenuConfig?: import("../../src/utils/graphicalMenu").GraphicalMenuConfig;
  session: RuntimeSession;
  connectionEpoch: number;
  send: (message: ClientMessage) => boolean;
  onGraphicalMessage: (listener: (message: GraphicalMessage) => void) => () => void;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  submissionPending: boolean;
  onSubmitRequest: (requestId: string) => void;
};

export type CodexSheet = "configuration" | "version" | "capabilities" | "plugins" | "goal" | "review" | "terminals" | "account" | "sandbox" | "workspace" | "mcp-config";
export type CodeBuddySheet = "buddy-goal" | "buddy-side" | "buddy-tasks" | "buddy-jobs" | "buddy-plugins" | "buddy-mcp" | "buddy-version" | "buddy-config";
export type OpenCodeSheet = "opencode-capabilities" | "opencode-version" | "opencode-auth" | "opencode-revert";
type ActionSheet = OpenCodeSheet | CodeBuddySheet | CodexSheet | "menu" | "agent" | "agent-confirm" | "model" | "effort" | "history" | "permission" | "native-mode" | null;
export function useGraphicalSession({ session, connectionEpoch, send, onGraphicalMessage, draft, setDraft, submissionPending, onSubmitRequest }: GraphicalViewProps) {
  const [serviceModels, setServiceModels] = useState<Array<{ source: string; id: string; name: string }>>([]);
  const [buddyModelMetadata, setBuddyModelMetadata] = useState<Array<{ id: string; creditMultiplier?: string; promotions: Array<{ id: string; label: string }> }>>([]);
  const [codexPending, setCodexPending] = useState(false);
  const [references, setReferences] = useState<CodexCapabilityReference[]>([]);
  const [capabilityTab, setCapabilityTab] = useState<"skills" | "apps" | "mcp">("skills");
  const [historyArchived, setHistoryArchived] = useState(false);
  const historyArchivedRef = useRef(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const historyAppending = useRef(false);
  const rpcRef = useRef(new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; threadId: string | null; allowThreadChange: boolean; mutation?: boolean }>());
  const rejectRequests = (reason: string, preserveTransitions = false) => {
    for (const [id, pending] of rpcRef.current) { if (preserveTransitions && pending.allowThreadChange) continue; clearTimeout(pending.timer); pending.reject(new Error(reason)); rpcRef.current.delete(id); }
    setCodexPending(snapshotRef.current?.provider !== "codex" ? [...rpcRef.current.values()].some(value => value.mutation) : rpcRef.current.size > 0);
  };
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
  const [openCodeRevertTarget, setOpenCodeRevertTarget] = useState<string | null>(null);
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
  const permissionIdRef = useRef<string | null>(null);
  const [changingPermission, setChangingPermission] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  const [changingModel, setChangingModel] = useState(false);
  const [changingEffort, setChangingEffort] = useState(false);
  const effortIdRef = useRef<string | null>(null);
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
    rejectRequests("会话已切换。");
    setServiceModels([]); setBuddyModelMetadata([]); setReferences([]); setHistoryArchived(false); historyArchivedRef.current = false; setHistoryQuery("");
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
    setChangingPermission(false);
    setChangingModel(false);
    setChangingEffort(false);
    setAttachments([]);
    setSwitchingTo(null);
    setExpandedGroupId(null);
    pendingRef.current.clear();
    modeIdRef.current = null;
    permissionIdRef.current = null;
    quickIdRef.current = null;
    quickDraftRef.current = "";
    modelIdRef.current = null;
    effortIdRef.current = null;
    switchIdRef.current = null;
    threadRef.current = null;
    const unsubscribe = onGraphicalMessage(message => {
      if (message.type === "graphical.result") {
        const pending = rpcRef.current.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer); rpcRef.current.delete(message.requestId); setCodexPending(snapshotRef.current?.provider !== "codex" ? [...rpcRef.current.values()].some(value => value.mutation) : rpcRef.current.size > 0);
        if (message.sessionId !== session.id || pending.threadId !== message.threadId || !pending.allowThreadChange && message.threadId !== threadRef.current) pending.reject(new Error("对话已切换。"));
        else pending.resolve(message.result);
        return;
      }
      if (message.type === "error" && message.requestId && rpcRef.current.has(message.requestId)) {
        const pending = rpcRef.current.get(message.requestId)!;
        clearTimeout(pending.timer); rpcRef.current.delete(message.requestId); setCodexPending(snapshotRef.current?.provider !== "codex" ? [...rpcRef.current.values()].some(value => value.mutation) : rpcRef.current.size > 0); pending.reject(new Error(message.message)); return;
      }
      if (message.type === "graphical.snapshot" && message.sessionId === session.id) {
        if (snapshotRef.current && snapshotRef.current.provider !== message.snapshot.provider) rejectRequests("Agent 已切换。");
        if (threadRef.current !== message.snapshot.threadId) {
          rejectRequests("对话已切换。", true); setReferences([]);
          if (quickIdRef.current) pendingRef.current.delete(quickIdRef.current);
          quickIdRef.current = null;
          quickDraftRef.current = "";
          setSending(false);
          if (permissionIdRef.current) pendingRef.current.delete(permissionIdRef.current);
          permissionIdRef.current = null; setChangingPermission(false);
          if (effortIdRef.current) pendingRef.current.delete(effortIdRef.current);
          effortIdRef.current = null; setChangingEffort(false);
          for (const item of attachmentsRef.current) cancelledUploads.current.add(item.key);
          const fileIds = attachmentsRef.current.flatMap(item => item.fileId ? [item.fileId] : []);
          if (fileIds.length) send({ v: PROTOCOL_VERSION, type: "graphical.upload.discard", sessionId: session.id,
            threadId: threadRef.current, fileIds, requestId: createRequestId() });
          setHistory(null);
          setActiveSheet(sheet => sheet === "opencode-auth" && message.snapshot.provider === "opencode" ? sheet : null);
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
          const turnDiffs = [...(current.turnDiffs || [])];
          for (const diff of message.turnDiffs || []) { const index = turnDiffs.findIndex(value => value.turnId === diff.turnId); if (index < 0) turnDiffs.push(diff); else turnDiffs[index] = diff; }
          const next = { ...current, revision: message.revision, items, turnDiffs,
            subAgents: applySubAgentTextDeltas(current.subAgents, message.subAgentTextDeltas) };
          snapshotRef.current = next;
          setSnapshot(next);
        }
      } else if (message.type === "graphical.history" && message.sessionId === session.id
        && message.requestId === historyIdRef.current && message.threadId === threadRef.current) {
        pendingRef.current.delete(message.requestId);
        setHistory(current => current && historyAppending.current
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
        if (submitIdRef.current === message.requestId) { setReferences([]); setAttachments([]); setSending(false); submitIdRef.current = null; }
        if (quickIdRef.current === message.requestId) {
          const quickDraft = quickDraftRef.current;
          if (quickDraft) setDraftRef.current(current => current + quickDraft);
          quickDraftRef.current = "";
          quickIdRef.current = null;
          setSending(false);
        }
        if (modeIdRef.current === message.requestId) {
          setChangingMode(false); modeIdRef.current = null;
          setActiveSheet(current => current === "native-mode" ? null : current);
        }
        if (permissionIdRef.current === message.requestId) {
          setChangingPermission(false); permissionIdRef.current = null;
          setActiveSheet(current => current === "permission" ? null : current);
        }
        if (effortIdRef.current === message.requestId) { setChangingEffort(false); effortIdRef.current = null; }
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
        if (permissionIdRef.current === message.requestId) { setChangingPermission(false); permissionIdRef.current = null; }
        if (effortIdRef.current === message.requestId) { setChangingEffort(false); effortIdRef.current = null; }
        if (modelIdRef.current === message.requestId) { setChangingModel(false); modelIdRef.current = null; }
        if (switchIdRef.current === message.requestId) { setSwitchingTo(null); switchIdRef.current = null; }
        if (historyIdRef.current === message.requestId) setHistoryLoading(false);
      }
    });
    return () => {
      rejectRequests("会话已关闭。");
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
    if (!connectionEpoch) {
      rejectRequests("连接中断，操作结果未确认，请重新连接后核对。");
      if (permissionIdRef.current) {
        pendingRef.current.delete(permissionIdRef.current);
        permissionIdRef.current = null;
        setChangingPermission(false);
        setError("连接中断，权限切换结果未确认；请重新连接后核对。");
      }
      return;
    }
    if (subscribedEpochRef.current && subscribedEpochRef.current !== connectionEpoch) {
      if (pendingRef.current.size || uploadRequests.current.size) setError("连接中断，操作结果未确认；请核对会话内容后再重试。");
      pendingRef.current.clear();
      submitIdRef.current = null;
      quickIdRef.current = null;
      quickDraftRef.current = "";
      modeIdRef.current = null;
      permissionIdRef.current = null;
      modelIdRef.current = null;
      effortIdRef.current = null;
      switchIdRef.current = null;
      historyIdRef.current = null;
      historyMutationRef.current = null;
      setHistoryMutation(null);
      setSending(false);
      setChangingMode(false);
      setChangingPermission(false);
      setChangingModel(false);
      setChangingEffort(false);
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

  useEffect(() => {
    if (activeSheet === "effort" && (!snapshot || !openCodeEffortOption(snapshot))) setActiveSheet(null);
  }, [activeSheet, snapshot]);

  const lastItem = snapshot?.items.at(-1);
  useEffect(() => { scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight }); }, [snapshot?.items.length, lastItem?.text, lastItem?.output]);

  useEffect(() => {
    if (!activeSheet) return;
    sheetRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !activeSheet.startsWith("buddy-")) setActiveSheet(null);
      if (event.key !== "Tab" || !sheetRef.current) return;
      const elements = [...sheetRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]")];
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
    if (snapshot.provider === "opencode" && (codexPending || ["running", "reconnecting"].includes(snapshot.acpAuth?.status || "")) && !["graphical.cancelQuestion", "graphical.answer", "graphical.approval", "graphical.interrupt"].includes(payload.type)) return;
    if (historyMutationRef.current && ["graphical.submit", "graphical.new-thread", "graphical.resume",
      "graphical.model", "graphical.effort", "graphical.mode", "graphical.native-mode", "graphical.plan"].includes(payload.type)) return;
    const id = createRequestId();
    const message = { v: PROTOCOL_VERSION, sessionId: session.id, threadId: snapshot.threadId,
      requestId: id, ...payload } as ClientMessage;
    if (!send(message)) { setError("连接已断开，请重试。"); return; }
    pendingRef.current.add(id);
    return id;
  };

  const providerRequest = <T = unknown,>(provider: "codex" | "codebuddy" | "opencode", command: CodexCommand | CodeBuddyCommand | OpenCodeCommand, input: Record<string, unknown> = {}): Promise<T> => {
    const current = snapshotRef.current;
    if (provider === "opencode" && !current?.openCodeMobile) return Promise.reject(new Error("请更新桌面宿主后重试。"));
    if (provider === "codebuddy" && !current?.codeBuddyMobile) return Promise.reject(new Error("请更新桌面宿主后重试。"));
    if (!current || current.provider !== provider) return Promise.reject(new Error("图形会话不可用。"));
    if (provider === "codex" && rpcRef.current.size && !["models", "version", "capabilities", "workspace-search", "attachment-preview", "app-detail", "plugin-detail", "plugin-skill", "mcp-resource", "history.initial"].includes(command)) return Promise.reject(new Error("操作正在处理，请稍候。"));
    const mutation = provider === "codex" ? ["permission-profile", "permission-legacy"].includes(command) : provider === "opencode" ? !["capabilities", "version", "attachment-preview", "auth-write", "auth-resize", "auth-cancel"].includes(command) : provider === "codebuddy" && !["version", "models", "model-metadata", "main-agents", "goal.read", "tasks", "jobs", "job-context", "job-history", "job-transcript", "plugins", "mcp-config", "mcp-runtime", "app-load", "app-read", "attachment-preview", "app-dispose", "side-cancel", "app-resolve"].includes(command);
    if (provider === "opencode" && mutation && (current.busy || current.pendingPlan || current.approvals.length || current.questions.length || isSending || attachmentsRef.current.length)) return Promise.reject(new Error("当前会话不可执行此操作。"));
    if (mutation && [...rpcRef.current.values()].some(value => value.mutation)) return Promise.reject(new Error("操作正在处理，请稍候。"));
    const requestId = createRequestId();
    if (provider === "codex" || mutation) setCodexPending(true); if (provider === "codex" || mutation) setError("");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { rpcRef.current.delete(requestId); setCodexPending(snapshotRef.current?.provider !== "codex" ? [...rpcRef.current.values()].some(value => value.mutation) : rpcRef.current.size > 0); reject(new Error("请求超时，操作结果未确认，请刷新后核对。")); }, 120000);
      rpcRef.current.set(requestId, { resolve: value => resolve(value as T), reject, timer, threadId: current.threadId, mutation, allowThreadChange: ["permission-profile", "permission-legacy", "history.fork", "fast-mode", "model-source", "mcp-restart", "rewind", "reconnect", "auth-start", "revert", "restore"].includes(command) });
      if (!send({ v: PROTOCOL_VERSION, type: `graphical.${provider}.${command}`, sessionId: session.id, threadId: current.threadId, requestId, input } as ClientMessage)) {
        clearTimeout(timer); rpcRef.current.delete(requestId); setCodexPending(snapshotRef.current?.provider !== "codex" ? [...rpcRef.current.values()].some(value => value.mutation) : rpcRef.current.size > 0); reject(new Error("连接已断开，请重试。"));
      }
    });
  };
  const codexRequest = <T = unknown,>(command: CodexCommand, input: Record<string, unknown> = {}) => providerRequest<T>("codex", command, input);
  const buddyRequest = <T = unknown,>(command: CodeBuddyCommand, input: Record<string, unknown> = {}) => providerRequest<T>("codebuddy", command, input);
  const openCodeRequest = <T = unknown,>(command: OpenCodeCommand, input: Record<string, unknown> = {}) => providerRequest<T>("opencode", command, input);
  const insertReference = (text: string, reference?: CodexCapabilityReference) => {
    setDraft(current => `${current}${current && !/\s$/.test(current) ? " " : ""}${text} `);
    if (reference) setReferences(current => [...current.filter(value => value.path !== reference.path), reference]);
    setActiveSheet(null);
  };
  const slashCommands = snapshot?.provider === "opencode" ? [
    ["new", "新对话"], ["history", "历史会话"], ["mode", "模式"], ...(snapshot.acpOptions?.some(option => option.id === "model") ? [["model", "模型"]] : []), ...(openCodeEffortOption(snapshot) ? [["effort", "思考强度"]] : []), ["files", "附加文件"], ...(snapshot.availableCommands || []).map(command => [command.name, command.description || "OpenCode 命令"])
  ].filter((row, index, rows) => rows.findIndex(value => value[0] === row[0]) === index) : snapshot?.provider === "codebuddy" ? [
    ["new", "新对话"], ["history", "历史会话"], ["mode", "模式"], ["model", "模型"], ...(snapshot.codeBuddyMobile ? [["mainAgent", "主 Agent"], ...(codeBuddyMultitaskOption(snapshot) ? [["multitask", "Multitask"]] : []), ["contextWindow", "上下文窗口"], ["goal", "目标管理"]] : []),
    ...(snapshot.capabilities?.sideQuestion ? [["btw", "独立旁问"]] : []),
    ...(session.type === "windows" && snapshot.codeBuddyMobile ? [["plugins", "插件管理"], ["codeBuddyJobs", "后台智能体"], ["tasks", "定时任务"], ["mcp", "MCP 管理"], ["version", "CLI 版本"]] : []),
    ...(snapshot.availableCommands || []).map(command => [command.name, command.description || "CodeBuddy 命令"])
  ].filter((row, index, rows) => rows.findIndex(value => value[0] === row[0]) === index) : [
    ["new", "新对话"], ["history", "历史会话"], ["skills", "Skills 列表"], ["apps", "Apps 列表"], ["mcp", "MCP 列表"],
    ["background", "后台终端"], ["compact", "压缩对话"], ["review", "代码审查"], ["goal", "目标管理"], ["plugins", "插件管理"],
    ["mode", "模式"], ["model", "模型"], ["effort", "思考强度"], ["fastMode", "快速模式"], ["permission", "执行权限"], ["files", "附加文件"]
  ].filter(([id]) => !["effort", "fastMode"].includes(id) || snapshot?.backend === "openai");
  const invokeSlash = (command: string) => {
    if (snapshot?.provider === "opencode") {
      if (command === "new") { if (snapshot.busy || isSending || codexPending) return false; action({ type: "graphical.new-thread" }); setDraft(""); }
      else if (command === "history") { openHistory(); setDraft(""); }
      else if (command === "mode" || command === "model" || command === "effort" || command === "files") { setActiveSheet(command === "mode" ? "native-mode" : command === "files" ? "menu" : command); setDraft(""); }
      else { setDraft(`/${command} `); }
      return true;
    }
    if (snapshot?.provider === "codebuddy") {
      if (command === "new") { if (snapshot.busy || isSending) return false; action({ type: "graphical.new-thread" }); }
      else if (command === "history") openHistory();
      else if (command === "model") setActiveSheet("model");
      else if (command === "mode") setActiveSheet("native-mode");
      else if (["mainAgent", "contextWindow"].includes(command) || command === "multitask" && snapshot.codeBuddyMobile && codeBuddyMultitaskOption(snapshot)) setActiveSheet("buddy-config");
      else if (["goal", "btw", "plugins", "codeBuddyJobs", "tasks", "mcp", "version"].includes(command)) {
        const sheets: Record<string, CodeBuddySheet> = { goal: "buddy-goal", btw: "buddy-side", plugins: "buddy-plugins", codeBuddyJobs: "buddy-jobs", tasks: "buddy-tasks", mcp: "buddy-mcp", version: "buddy-version" };
        setActiveSheet(sheets[command]);
      } else { setDraft(`/${command} `); return true; }
      setDraft(""); return true;
    }
    if (!snapshot || snapshot.provider !== "codex" || !slashCommands.some(([id]) => id.toLowerCase() === command.toLowerCase())) return false;
    if (["new", "compact", "review", "mode", "model", "effort", "fastMode", "permission"].includes(command) && (snapshot.busy || snapshot.archived || isSending)) return false;
    if (command === "new") action({ type: "graphical.new-thread" });
    else if (command === "history") openHistory();
    else if (["skills", "apps", "mcp"].includes(command)) { setCapabilityTab(command as typeof capabilityTab); setActiveSheet("capabilities"); }
    else if (command === "background") setActiveSheet("terminals");
    else if (command === "mode" || command === "files") setActiveSheet("menu");
    else if (command === "compact") void codexRequest("compact").catch(cause => setError(String(cause)));
    else if (command === "fastMode") void codexRequest("fast-mode", { enabled: !snapshot.fastMode }).catch(cause => setError(String(cause)));
    else setActiveSheet(command as ActionSheet);
    setDraft(""); return true;
  };
  const submit = () => {
    const text = draft.trim();
    if (!(snapshot?.provider === "opencode" && !["new", "history", "mode", "model", "effort", "files"].includes(text.slice(1))) && text.startsWith("/") && slashCommands.some(([id]) => id.toLowerCase() === text.slice(1).toLowerCase()) && invokeSlash(text.slice(1))) return;
    if (!supportsCodexImageInput(snapshotRef.current) && attachments.some(item => isCodexImageFile(item.file.name))) {
      setError(`${IMAGE_INPUT_UNSUPPORTED}，请先移除图片附件。`); return;
    }
    const ready = attachments.filter(item => item.status === "ready" && item.fileId);
    if (snapshot?.provider === "codex" && [...rpcRef.current.values()].some(value => value.mutation)) return;
    if ((!text && !ready.length) || attachments.some(item => item.status !== "ready") || !snapshot?.threadId || isSending || historyMutationRef.current || !graphicalInputPolicy(snapshot).canSubmit) return;
    submitIdRef.current = action({ type: "graphical.submit", text, fileIds: ready.map(item => item.fileId), references }) || null;
    if (submitIdRef.current) { onSubmitRequest(submitIdRef.current); setSending(true); }
  };
  const runQuickCommand = (command: QuickCommand) => {
    if (snapshot?.provider === "opencode" && codexPending) return false;
    if (!snapshot || !graphicalInputPolicy(snapshot, Boolean(historyMutationRef.current)).canInput) return false;
    if ((command.mode || "write") === "write") { setDraft(current => current + command.command); return true; }
    if (isSending || quickIdRef.current || historyMutationRef.current || !graphicalInputPolicy(snapshot).canSubmit) return false;
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
    if (!snapshot || snapshot.busy || snapshot.archived || changingModel || changingEffort || attachments.length || !modelOptions(snapshot).some(option => option.value === modelId)) return;
    modelIdRef.current = action({ type: "graphical.model", modelId }) || null;
    if (modelIdRef.current) { setChangingModel(true); setActiveSheet(null); }
  };
  const changeEffort = (effort: string) => {
    const option = snapshot && openCodeEffortOption(snapshot);
    if (!snapshot?.threadId || !option || snapshot.busy || snapshot.archived || isSending
      || changingModel || changingEffort || modelIdRef.current || effortIdRef.current || attachments.length
      || historyMutationRef.current || snapshot.pendingPlan || snapshot.approvals.length || snapshot.questions.length
      || effort === option.currentValue || !option.options.some(value => value.value === effort)) return;
    effortIdRef.current = action({ type: "graphical.effort", effort }) || null;
    if (effortIdRef.current) { setChangingEffort(true); setActiveSheet(null); }
  };
  const uploadFile = async (file: File, key: string) => {
    if (!supportsCodexImageInput(snapshotRef.current) && isCodexImageFile(file.name)) {
      setAttachments(current => current.map(item => item.key === key ? { ...item, status: "failed" } : item));
      setError(IMAGE_INPUT_UNSUPPORTED); return;
    }
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
      if (!supportsCodexImageInput(snapshotRef.current) && isCodexImageFile(file.name)) throw new Error(IMAGE_INPUT_UNSUPPORTED);
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
    const imagesAllowed = supportsCodexImageInput(snapshotRef.current);
    const candidates = [...files].filter(file => imagesAllowed || !isCodexImageFile(file.name));
    if (candidates.length < files.length) setError(IMAGE_INPUT_UNSUPPORTED);
    const chosen = candidates.slice(0, Math.max(0, 10 - attachments.length));
    if (chosen.length < candidates.length) setError("最多附加 10 个文件。");
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
    if (!snapshot || snapshot.provider !== "codex" || !snapshot.threadId || snapshot.busy || permissionIdRef.current
      || snapshot.executionPermission === permission && !snapshot.permissionProfileId || snapshot.capabilities?.supportedPermissions && !snapshot.capabilities.supportedPermissions.includes(permission)) return;
    setError("");
    permissionIdRef.current = action({ type: "graphical.permission", permission }) || null;
    if (permissionIdRef.current) setChangingPermission(true);
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
    if (historyMutationRef.current || snapshot?.provider === "opencode" && (codexPending || ["running", "reconnecting"].includes(snapshot.acpAuth?.status || ""))) return;
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
  const loadHistory = (cursor: string | null = null, archived = historyArchivedRef.current) => {
    if (!snapshot) return;
    historyAppending.current = Boolean(cursor);
    historyArchivedRef.current = archived; setHistoryArchived(archived);
    setHistoryLoading(true);
    if (!cursor) setHistory(null);
    historyIdRef.current = action({ type: "graphical.history", cursor, archived }) || null;
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

  useEffect(() => {
    if (snapshot?.provider !== "codebuddy" || !snapshot.codeBuddyMobile || !snapshot.threadId || session.type !== "windows") return;
    let active = true;
    void buddyRequest<typeof buddyModelMetadata>("model-metadata").then(value => { if (active) setBuddyModelMetadata(value); }).catch(() => { if (active) setBuddyModelMetadata([]); });
    return () => { active = false; };
  }, [snapshot?.provider, snapshot?.threadId, snapshot?.codeBuddyMobile, session.type]);
  useEffect(() => {
    if (activeSheet !== "model" || !["codex", "codebuddy"].includes(snapshot?.provider || "") || snapshot?.provider === "codebuddy" && !snapshot.codeBuddyMobile || session.type === "ssh") return;
    let active = true;
    void (snapshot?.provider === "codebuddy" ? buddyRequest<typeof serviceModels>("models") : codexRequest<typeof serviceModels>("models")).then(value => { if (active) setServiceModels(value); }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [activeSheet, snapshot?.threadId]);
  useEffect(() => {
    if (snapshot?.provider === "codex" && activeSheet === "history" && historyQuery.trim() && history?.nextCursor && !historyLoading) loadHistory(history.nextCursor);
  }, [activeSheet, historyQuery, history, historyLoading]);
  return { openCodeRevertTarget, setOpenCodeRevertTarget, openCodeRequest, onGraphicalMessage, buddyModelMetadata, buddyRequest, session, capabilityTab, setCapabilityTab, slashCommands, invokeSlash, serviceModels, codexPending, references, setReferences, codexRequest, insertReference, historyArchived, historyQuery, setHistoryQuery, snapshot, isSending: isSending || Boolean(historyMutation) || snapshot?.provider === "codex" && [...rpcRef.current.values()].some(value => value.mutation), error, setError, activeSheet, setActiveSheet, selectedProvider, setSelectedProvider,
    history, historyLoading, historyMutation, mutateHistory, expandedGroupId, setExpandedGroupId, changingMode, changingPermission, changingModel, changingEffort,
    attachments, setAttachments, switchingTo, scrollRef, moreButtonRef, sheetRef, action, submit,
    runQuickCommand, changeModel, changeEffort, uploadFile, addFiles, removeAttachment, changeMode, changePermission,
    changeNativeMode, executeOpenCodePlan, switchAgent, loadHistory, openHistory };
}
