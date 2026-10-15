import { WorkspaceMentionFilter, workspaceMentionFilterKey } from "../shared/WorkspaceMentionFilter";
import { GraphicalMessageCopy, graphicalMessageText } from "./GraphicalMessageCopy";
import { GraphicalMenuSettingsDialog } from "../settings/GraphicalMenuSettingsDialog";
import { GraphicalActionMenu } from "../shared/GraphicalActionMenu";
import { useGraphicalMenuConfig } from "../../utils/useGraphicalMenuConfig";
import { OpenCodeRetryStatus } from "./OpenCodeRetryStatus";
import { CompactionCard } from "../shared/CompactionCard";
import { IMAGE_INPUT_UNSUPPORTED, isCodexImageFile, supportsCodexImageInput } from "../../utils/codexImageInput";
import { CodexConfigurationPanel } from "./CodexConfigurationPanel";
import { CodeBuddyMcpDialog } from "./CodeBuddyMcpDialog";
import { CodeBuddyMcpAppContext } from "./CodeBuddyMcpApp";
import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { ArrowUp, BookOpen, Cable, Check, ChevronRight, Ellipsis, File as FileIcon, Folder, Globe2, History, Minimize2, Package, Paperclip, Pin, Plus, RefreshCw, Sparkles, Square, Target, Terminal, Wrench, X } from "lucide-react";
import type { AgentModelSource, CodexAppServerHistory, CodexAppServerSnapshot, CodexCapabilityReference, CodexSessionCapabilities, CodexExecutionPermission, QuickCommand, TerminalSession, WorkspaceEntrySearchResult, WorkspaceEntryTypeFilter } from "../../vite-env";
import { MarkdownBlock } from "../shared/MarkdownBlock";
import { CodexSubAgentPanel } from "./CodexSubAgentPanel";
import { CodexAccountPanel } from "./CodexAccountPanel";
import { CodexGoalDialog } from "./CodexGoalDialog";
import { CodeBuddyScheduledTasksDialog } from "./CodeBuddyScheduledTasksDialog";
import { CodeBuddySideQuestionDialog } from "./CodeBuddySideQuestionDialog";
import { CodeBuddyGoalDialog } from "./CodeBuddyGoalDialog";
import { CodexReviewDialog } from "./CodexReviewDialog";
import { CodexVersionControl } from "./CodexVersionControl";
import { CodexPluginDialog } from "./CodexPluginDialog";
import { CodeBuddyPluginDialog } from "./CodeBuddyPluginDialog";
import { CodexCapabilityDetail, type CapabilityDetailTarget } from "./CodexCapabilityDetail";
import { CodexWindowsSandboxDialog } from "./CodexWindowsSandboxDialog";
import { CodexBackgroundTerminalsDialog } from "./CodexBackgroundTerminalsDialog";
import { CodeBuddyJobsDialog } from "./CodeBuddyJobsDialog";
import { OpenCodeAuthDialog } from "./OpenCodeAuthDialog";
import { TurnDiffCard } from "./TurnDiffCard";
import { CodexEventCard, DiagnosticCard, groupTimeline, timelineItemClass, statusLabel, teamStatusLabels, TeamMemberTimeline, ToolGroup } from "./GraphicalTimeline";
import { AttachmentTile, ApprovalCard, McpElicitationCard, QuestionCard } from "./GraphicalInteractionCards";
import { subscribeGraphicalSession } from "./graphicalSessionSubscription";

const empty: CodexAppServerSnapshot = { threadId: null, mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, items: [], approvals: [] };
const permissionLabels: Record<CodexExecutionPermission, string> = { readOnly: "只读", askApproval: "需要确认", fullAccess: "完全访问" };
const permissionDescriptions: Record<CodexExecutionPermission, string> = {
  readOnly: "可检查文件，不能修改或申请扩权",
  askApproval: "可修改工作区，越界操作先确认",
  fullAccess: "可访问文件与网络，不再请求批准"
};
const codeBuddyModeDescriptions: Record<string, string> = {
  default: "自主分析并执行任务，可读取与修改文件、运行命令。",
  standard: "自主分析并执行任务，可读取与修改文件、运行命令。",
  acceptedits: "自动接受代码修改，无需逐项确认。",
  plan: "先制定计划并等待你确认，再开始执行（只读，不直接改动文件）。",
  bypasspermissions: "跳过权限确认，直接执行操作。",
  fullaccess: "授予完整执行权限，直接运行命令与修改文件。",
  auto: "自主分析并执行任务，遇到需确认的操作自动放行。",
  dontask: "运行命令与修改文件均不再弹出确认。",
  delegate: "将子任务委派给子 Agent 并行处理。"
};
const codeBuddyMainAgentDescriptions: Record<string, string> = {
  cli: "完整编程助手：可编辑文件、运行命令、搜索代码和网页，并使用技能、计划、目标及子 Agent。",
  ptc: "具备 Standard 的能力，通过 REPL / Code Mode 将多个工具操作编排为程序执行。",
  minimal: "仅通过 REPL 使用 Bash、文件编辑和技能，不支持 MCP、独立文件读取与搜索工具、计划或子 Agent；可通过 Bash 查看文件并读取命令输出。",
  create: "具备 Standard 的完整工具，并指导创建 ~/.codebuddy/agents 下的用户自定义 Agent；配置中需设置 mainAgent: true 才会出现在选择列表中。"
};
const normalizeModeKey = (value: string) => (value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function openCodePlanReplyId(snapshot: CodexAppServerSnapshot) {
  if (snapshot.provider !== "opencode" || snapshot.nativeMode !== "plan" || snapshot.busy || snapshot.archived
    || snapshot.error || snapshot.pendingPlan || !snapshot.threadId
    || !snapshot.nativeModes?.some(mode => normalizeModeKey(mode.id) === "build")) return null;
  const lastUserIndex = snapshot.items.map(item => item.type).lastIndexOf("userMessage");
  if (lastUserIndex < 0) return null;
  const reply = snapshot.items.slice(lastUserIndex + 1);
  if (reply.some(item => item.type === "turnError")) return null;
  return reply.filter(item => item.type === "agentMessage" && Boolean(item.text?.trim())
    || item.type === "turnPlan" && Boolean(item.plan?.length)).at(-1)?.id || null;
}
const effortLabels: Record<string, string> = {
  none: "无", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高", ultra: "极致"
};
const effortLabel = (effort: string) => effortLabels[effort] || effort;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
async function hasRecordedCodeBuddyError(sessionId: string, detail: string, knownErrorIds: Set<string>) {
  try {
    const current = await window.codexAppServerApi.snapshot(sessionId);
    return current.provider === "codebuddy" && current.items.some(item => item.type === "turnError"
      && !knownErrorIds.has(item.id) && item.text === detail);
  } catch { return false; }
}
type FileMention = { start: number; end: number; query: string };
function fileMentionAtCaret(value: string, caret: number): FileMention | null {
  const prefix = value.slice(0, caret);
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;
  return { start: prefix.length - match[0].length + match[0].lastIndexOf("@"), end: caret, query: match[1] };
}
type AttachmentPreview = Awaited<ReturnType<typeof window.codexAppServerApi.previewAttachment>>;
type SelectionKind = "mode" | "model" | "effort" | "fastMode" | "permission" | "contextWindow" | "multitask" | "mainAgent";
type SlashCommand = { id: string; label: string; disabled?: boolean; source?: "codebuddy" | "opencode" | "qoder" | "gemini" | "grok" };
const sendableImageFile = isCodexImageFile;
const fileName = (filePath: string) => filePath.split(/[\\/]/).pop() || filePath;
type InlineImage = { token: string; path: string | null };
function orderedDraft(draft: string, images: InlineImage[]) {
  const byToken = new Map(images.filter(image => image.path).map(image => [image.token, image.path!]));
  const parts: Array<{ type: "text"; text: string } | { type: "image"; path: string }> = [];
  const pattern = /〔图片 \d+〕/g;
  let offset = 0;
  const seen = new Set<string>();
  for (const match of draft.matchAll(pattern)) {
    const imagePath = byToken.get(match[0]);
    if (!imagePath || seen.has(match[0])) continue;
    if (match.index > offset) parts.push({ type: "text", text: draft.slice(offset, match.index) });
    parts.push({ type: "image", path: imagePath });
    seen.add(match[0]);
    offset = match.index + match[0].length;
  }
  if (offset < draft.length) parts.push({ type: "text", text: draft.slice(offset) });
  return { text: parts.filter(part => part.type === "text").map(part => part.text).join("").trim(), parts };
}
function userMessageCopyText(item: { text?: string; attachments?: Array<{ path: string }> }) {
  const attachments = item.attachments?.map(file => file.path) || [];
  return [item.text || "", attachments.length ? `附件：\n${attachments.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

export type CodexAppServerSessionHandle = {
  applyQuickCommand: (command: QuickCommand) => Promise<boolean>;
  appendFilePath: (path: string) => void;
};

type CodexAppServerSessionProps = {
  sessionId: string;
  isActive?: boolean;
  isCompleted?: boolean;
  minimalMode?: boolean;
  session?: TerminalSession;
  sessionType?: "windows" | "wsl" | "ssh";
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  draftReferences?: CodexCapabilityReference[];
  setDraftReferences?: Dispatch<SetStateAction<CodexCapabilityReference[]>>;
  onLinkClick?: (href: string) => void;
  onSessionCreated?: (sessionId: string) => void;
  onReconnectModels?: (sessionId: string) => Promise<void>;
  onSwitchCodeBuddyModel?: (sessionId: string, source: AgentModelSource, modelId?: string) => Promise<void>;
  onSwitchCodexModel?: (sessionId: string, source: AgentModelSource, modelId?: string) => Promise<void>;
};

export const CodexAppServerSession = forwardRef<CodexAppServerSessionHandle, CodexAppServerSessionProps>(function CodexAppServerSession({ sessionId, isActive = true, isCompleted = false, minimalMode = false, session, sessionType = "windows", draft, setDraft, draftReferences = [], setDraftReferences = () => {}, onLinkClick, onSessionCreated, onReconnectModels, onSwitchCodeBuddyModel, onSwitchCodexModel }, ref) {
  const [snapshot, setSnapshot] = useState<CodexAppServerSnapshot>(empty);
  const [selectedMemberName, setSelectedMemberName] = useState<string | null>(null);
  const [memberDraft, setMemberDraft] = useState("");
  const [sendingMember, setSendingMember] = useState(false);
  const [memberError, setMemberError] = useState("");
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const timelineRef = useRef<CodexAppServerSnapshot | null>(null);
  const [error, setError] = useState("");
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [historyCopyingThreadId, setHistoryCopyingThreadId] = useState<string | null>(null);
  const [dismissedSnapshotError, setDismissedSnapshotError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const rewindDraftRef = useRef({ draft, hasAttachments: attachments.length > 0 });
  rewindDraftRef.current = { draft, hasAttachments: attachments.length > 0 };
  const [inlineImages, setInlineImages] = useState<InlineImage[]>([]);
  const [previewFile, setPreviewFile] = useState<{ path: string; name: string } | null>(null);
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [pastingImage, setPastingImage] = useState(false);
  const [sending, setSending] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  const [changingModel, setChangingModel] = useState(false);
  const [changingMultitask, setChangingMultitask] = useState(false);
  const [changingPermission, setChangingPermission] = useState(false);
  const [resolvingPlan, setResolvingPlan] = useState(false);
  const [history, setHistory] = useState<CodexAppServerHistory[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyArchived, setHistoryArchived] = useState(false);
  const [historyMutation, setHistoryMutation] = useState<string | null>(null);
  const [forkingTurnId, setForkingTurnId] = useState<string | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [rewindTarget, setRewindTarget] = useState<{ messageId: string; text: string } | null>(null);
  const [rewindScope, setRewindScope] = useState<"Code" | "Conversation" | "CodeAndConversation">("CodeAndConversation");
  const [rewindPending, setRewindPending] = useState(false);
  const [openCodeLoginOpen, setOpenCodeLoginOpen] = useState(false);
  const [rewindError, setRewindError] = useState("");
  const [revertedInput, setRevertedInput] = useState("");
  const [scheduledTasksOpen, setScheduledTasksOpen] = useState(false);
  const [sideQuestionOpen, setSideQuestionOpen] = useState(false);
  const [sideQuestionInitial, setSideQuestionInitial] = useState("");
  const canAskSideQuestion = snapshot.provider === "codebuddy" && sessionType === "windows" && session?.type !== "ssh" && snapshot.capabilities?.sideQuestion !== false;
  const btwMatch = canAskSideQuestion ? /^\/btw(?:\s+([\s\S]*))?$/.exec(draft.trim()) : null;
  const [goalOpen, setGoalOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [codeBuddyMcpOpen, setCodeBuddyMcpOpen] = useState(false);
  const [pluginOpen, setPluginOpen] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [sandboxSetupOpen, setSandboxSetupOpen] = useState(false);
  const [backgroundTerminalsOpen, setBackgroundTerminalsOpen] = useState(false);
  const [codeBuddyJobsOpen, setCodeBuddyJobsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuSettingsOpen, setMenuSettingsOpen] = useState(false);
  const { config: graphicalMenuConfig } = useGraphicalMenuConfig();
  const [selectionKind, setSelectionKind] = useState<SelectionKind | null>(null);
  const [selectionError, setSelectionError] = useState("");
  const [selectionPending, setSelectionPending] = useState(false);
  const [mainAgentLoading, setMainAgentLoading] = useState(false);
  const mainAgentPending = selectionKind === "mainAgent" && selectionPending;
  const [modelMetadata, setModelMetadata] = useState<Awaited<ReturnType<typeof window.codexAppServerApi.listModelMetadata>>>([]);
  const [codeBuddyServiceModels, setCodeBuddyServiceModels] = useState<Array<{ source: AgentModelSource; id: string; name: string }>>([]);
  const [codeBuddyModelLoadError, setCodeBuddyModelLoadError] = useState("");
  const [codexServiceModels, setCodexServiceModels] = useState<Array<{ source: AgentModelSource; id: string; name: string }>>([]);
  const [codexModelLoadError, setCodexModelLoadError] = useState("");
  const [openCodeVerifiedModels, setOpenCodeVerifiedModels] = useState<{ sessionId: string; threadId: string | null; ids: Set<string> } | null>(null);
  const [openCodeModelLoadError, setOpenCodeModelLoadError] = useState("");
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [capabilityTab, setCapabilityTab] = useState<"skills" | "apps" | "mcp">("skills");
  const [capabilityQuery, setCapabilityQuery] = useState("");
  const [capabilities, setCapabilities] = useState<CodexSessionCapabilities | null>(null);
  const [capabilityLoading, setCapabilityLoading] = useState(false);
  const [skillPendingPath, setSkillPendingPath] = useState<string | null>(null);
  const capabilityRequestRef = useRef(0);
  const skillWriteRef = useRef<object | null>(null);
  const [capabilityError, setCapabilityError] = useState("");
  const [capabilityDetail, setCapabilityDetail] = useState<CapabilityDetailTarget | null>(null);
  const [entryType, setEntryType] = useState<WorkspaceEntryTypeFilter>("all");
  const [fileMention, setFileMention] = useState<FileMention | null>(null);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [fileResults, setFileResults] = useState<WorkspaceEntrySearchResult[]>([]);
  const [fileSearchStatus, setFileSearchStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [fileSearchError, setFileSearchError] = useState("");
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historySlow, setHistorySlow] = useState(false);
  const [resumingHistory, setResumingHistory] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const wasActiveRef = useRef(false);
  const followMessagesRef = useRef(true);
  const completedScrollRef = useRef<{ sessionId: string; threadId: string | null; top: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileResultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileSearchRequestRef = useRef(0);
  const fileListId = useId();
  const slashListId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const selectionDialogRef = useRef<HTMLDivElement>(null);
  const capabilityRef = useRef<HTMLDivElement>(null);
  const historyRequestRef = useRef(0);
  const currentSessionRef = useRef(sessionId);
  const modelMetadataSessionRef = useRef<string | null>(null);
  const modelMetadataRequestRef = useRef(0);
  const loadedSessionIdRef = useRef<string | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const pastedImagesRef = useRef(new Set<string>());
  const inlineImagesRef = useRef<InlineImage[]>([]);
  const imageTokenCounterRef = useRef(0);
  const pastingRef = useRef(false);
  const changingModeRef = useRef(false);
  const changingModelRef = useRef(false);
  const changingPermissionRef = useRef(false);
  const resolvingPlanRef = useRef(false);
  currentSessionRef.current = sessionId;

  async function copyText(value: string, label: string) {
    try {
      const copied = await window.clipboardApi.writeText(value);
      if (currentSessionRef.current === sessionId) setCopyNotice(copied ? `${label} 已复制` : `${label} 复制失败`);
    } catch {
      if (currentSessionRef.current === sessionId) setCopyNotice(`${label} 复制失败`);
    }
  }

  async function copyInitialUserInput(threadId: string) {
    setHistoryCopyingThreadId(threadId);
    setCopyNotice(null);
    try {
      const input = await window.codexAppServerApi.readInitialUserInput(sessionId, threadId);
      if (currentSessionRef.current !== sessionId) return;
      const value = input && userMessageCopyText(input);
      if (value) await copyText(value, "首条用户输入");
      else setCopyNotice("未找到首条用户输入");
    } catch (cause) {
      if (currentSessionRef.current === sessionId) setCopyNotice(`读取首条用户输入失败：${message(cause)}`);
    } finally {
      if (currentSessionRef.current === sessionId) setHistoryCopyingThreadId(null);
    }
  }

  useImperativeHandle(ref, () => ({
    appendFilePath(path) {
      if (!isActive) return;
      setDraft(current => current + (current && !/\s$/.test(current) ? " " : "") + path);
      window.requestAnimationFrame(() => {
        if (currentSessionRef.current === sessionId) textareaRef.current?.focus();
      });
    },
    async applyQuickCommand(command) {
      if (!isActive) return false;
      if (loadedSessionIdRef.current !== sessionId || !snapshot.threadId) return false;
      if (command.mode !== "auto-enter") {
        setDraft(current => current + command.command);
        textareaRef.current?.focus();
        return true;
      }
      if (snapshot.compacting || snapshot.reviewing || (snapshot.busy && snapshot.provider !== "codex" && snapshot.provider != null) || sending || pastingImage) return false;
      const knownErrorIds = new Set(snapshot.items.filter(item => item.type === "turnError").map(item => item.id));
      setSending(true); setError("");
      try {
        await window.codexAppServerApi.submit(sessionId, command.command, []);
        return true;
      } catch (cause) {
        const recorded = snapshot.provider === "codebuddy" && await hasRecordedCodeBuddyError(sessionId, message(cause), knownErrorIds);
        if (currentSessionRef.current === sessionId && !recorded) setError(message(cause));
        return false;
      } finally {
        if (currentSessionRef.current === sessionId) setSending(false);
      }
    }
  }));

  useEffect(() => {
    if (isActive) return;
    setHistoryOpen(false);
    setSideQuestionOpen(false); setSideQuestionInitial("");
    setGoalOpen(false);
    setReviewOpen(false);
    setPluginOpen(false);
    setMenuOpen(false);
    setMenuSettingsOpen(false);
    setSelectionKind(null);
    setMainAgentLoading(false);
    setCapabilityOpen(false);
    setPreviewFile(null);
    setRewindTarget(null);
  }, [isActive]);

  useEffect(() => {
    loadedSessionIdRef.current = null;
    threadIdRef.current = null;
    timelineRef.current = null;
    setSnapshot(empty);
    setCopyNotice(null);
    setHistoryCopyingThreadId(null);
    setSelectedMemberName(null);
    setMemberDraft("");
    setSendingMember(false);
    setMemberError("");
    setExpandedGroupId(null);
    setError("");
    setDismissedSnapshotError(null);
    setAttachments([]);
    setInlineImages([]);
    inlineImagesRef.current = [];
    setDraft(current => current.replace(/〔图片 \d+〕/g, ""));
    setPreviewFile(null);
    setSending(false);
    setChangingMode(false);
    setChangingModel(false);
    setChangingPermission(false);
    setResolvingPlan(false);
    changingModeRef.current = false;
    changingModelRef.current = false;
    changingPermissionRef.current = false;
    resolvingPlanRef.current = false;
    pastedImagesRef.current.clear();
    setHistory([]);
    setHistoryCursor(null);
    setHistoryArchived(false);
    setHistoryMutation(null);
    setForkingTurnId(null);
    setRenamingThreadId(null);
    setHistoryOpen(false);
    setRewindTarget(null);
    setRevertedInput("");
    setRewindScope("CodeAndConversation");
    setRewindPending(false);
    setRewindError("");
    setSideQuestionOpen(false); setSideQuestionInitial("");
    setGoalOpen(false);
    setReviewOpen(false);
    setMenuOpen(false);
    setMenuSettingsOpen(false);
    setSelectionKind(null);
    setMainAgentLoading(false);
    setSelectionError("");
    setSelectionPending(false);
    setEntryType("all");
    setCapabilityOpen(false);
    setFileMention(null);
    setSlashDismissed(false);
    setSelectedSlashIndex(0);
    setFileResults([]);
    setFileSearchStatus("idle");
    setFileSearchError("");
    setSelectedFileIndex(0);
    fileSearchRequestRef.current += 1;
    setCapabilities(null);
    setCapabilityQuery("");
    setHistoryQuery("");
    setHistoryError("");
    setLoadingHistory(false);
    setHistorySlow(false);
    setResumingHistory(false);
    historyRequestRef.current += 1;
  }, [sessionId]);
  useEffect(() => {
    if (!isActive) return;
    return subscribeGraphicalSession(sessionId, {
      onSnapshot(next) {
        loadedSessionIdRef.current = sessionId;
        if (threadIdRef.current && threadIdRef.current !== next.threadId) {
          setRevertedInput("");
          setRewindTarget(null);
          setAttachments([]);
          setInlineImages([]);
          inlineImagesRef.current = [];
          pastedImagesRef.current.clear();
          setDraft(current => current.replace(/〔图片 \d+〕/g, ""));
          setPreviewFile(null);
          setPreview(null);
          setPreviewError("");
        }
        threadIdRef.current = next.threadId;
        if (timelineRef.current?.threadId !== next.threadId) setExpandedGroupId(null);
        timelineRef.current = next;
        setSnapshot(next);
      },
      onError(cause) { setError(message(cause)); }
    });
  }, [isActive, sessionId]);
  useEffect(() => {
    if (!snapshot.error) setDismissedSnapshotError(null);
  }, [snapshot.error]);
  useEffect(() => {
    const names = snapshot.team?.members.map(member => member.name) || [];
    if (!names.length) { setSelectedMemberName(null); return; }
    if (!selectedMemberName || !names.includes(selectedMemberName)) setSelectedMemberName(names[0]);
  }, [snapshot.team?.name, snapshot.team?.members, selectedMemberName]);
  useEffect(() => { setMemberDraft(""); setMemberError(""); }, [snapshot.threadId, snapshot.team?.name]);
  useEffect(() => {
    if (!fileMention) return;
    const requestId = ++fileSearchRequestRef.current;
    setFileSearchStatus("loading");
    setFileSearchError("");
    setFileResults([]);
    setSelectedFileIndex(0);
    const timer = window.setTimeout(() => {
      window.projectSearchApi.searchWorkspaceEntries(sessionId, fileMention.query, undefined, { entryType }).then(response => {
        if (fileSearchRequestRef.current !== requestId) return;
        setFileResults(response.results);
        setFileSearchStatus("ready");
      }).catch(cause => {
        if (fileSearchRequestRef.current !== requestId) return;
        setFileResults([]);
        setFileSearchError(message(cause));
        setFileSearchStatus("error");
      });
    }, 180);
    return () => { window.clearTimeout(timer); fileSearchRequestRef.current += 1; };
  }, [sessionId, fileMention?.query, fileMention?.start, fileMention?.end, entryType]);
  useEffect(() => {
    if (fileMention && fileResults[selectedFileIndex]) fileResultRefs.current[selectedFileIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [fileMention, fileResults, selectedFileIndex]);
  useLayoutEffect(() => {
    const savedScroll = completedScrollRef.current;
    if (!isCompleted || savedScroll && (savedScroll.sessionId !== sessionId || savedScroll.threadId !== snapshot.threadId)) {
      completedScrollRef.current = null;
    }
    if (!isActive) { wasActiveRef.current = false; return; }
    const messages = messagesRef.current;
    if (!messages) return;
    const becameActive = !wasActiveRef.current;
    wasActiveRef.current = true;
    if (becameActive && completedScrollRef.current) {
      messages.scrollTop = completedScrollRef.current.top;
      followMessagesRef.current = messages.scrollHeight - messages.clientHeight - messages.scrollTop <= 32;
    } else if (becameActive || followMessagesRef.current) {
      followMessagesRef.current = true;
      messages.scrollTop = messages.scrollHeight;
    }
  }, [isActive, isCompleted, sessionId, snapshot.threadId, snapshot.items, snapshot.approvals.length, snapshot.questions?.length, snapshot.elicitations?.length, snapshot.pendingPlan, error, snapshot.error]);
  useEffect(() => {
    if (!previewFile || !snapshot.threadId) return;
    let active = true;
    setPreview(null); setPreviewError("");
    void window.codexAppServerApi.previewAttachment(sessionId, previewFile.path).then(result => {
      if (active) setPreview(result);
    }).catch(cause => { if (active) setPreviewError(message(cause)); });
    return () => { active = false; };
  }, [sessionId, snapshot.threadId, previewFile]);
  useEffect(() => {
    if (!historyOpen) return;
    const timer = window.setTimeout(() => void loadHistory(null, historyQuery), historyQuery.trim() ? 150 : 0);
    return () => { window.clearTimeout(timer); historyRequestRef.current += 1; };
  }, [historyOpen, historyQuery, historyArchived, sessionId]);
  useEffect(() => {
    if (!menuOpen || !isActive) return;
    menuRef.current?.querySelector<HTMLButtonElement>(':scope > button:not(:disabled)')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !menuButtonRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen, isActive]);
  useEffect(() => {
    if (isActive && selectionKind) (selectionDialogRef.current?.querySelector<HTMLButtonElement>('button[role="radio"]:not(:disabled)')
      || selectionDialogRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
  }, [selectionKind, isActive]);
  useEffect(() => {
    if (snapshot.provider !== "codebuddy" || !snapshot.threadId) {
      modelMetadataRequestRef.current += 1;
      modelMetadataSessionRef.current = null;
      setModelMetadata([]);
      return;
    }
    const key = `${sessionId}:${snapshot.threadId}`;
    if (!menuOpen && modelMetadataSessionRef.current === key) return;
    if (modelMetadataSessionRef.current !== key) setModelMetadata([]);
    modelMetadataSessionRef.current = key;
    const requestId = ++modelMetadataRequestRef.current;
    void Promise.resolve().then(() => window.codexAppServerApi.listModelMetadata?.(sessionId) ?? []).then(value => {
      if (modelMetadataRequestRef.current === requestId && currentSessionRef.current === sessionId)
        setModelMetadata(Array.isArray(value) ? value : []);
    }).catch(() => { if (modelMetadataRequestRef.current === requestId && currentSessionRef.current === sessionId) setModelMetadata([]); });
  }, [sessionId, snapshot.provider, snapshot.threadId, menuOpen]);
  useEffect(() => {
    if (selectionKind !== "model" || snapshot.provider !== "codebuddy" || sessionType === "ssh") return;
    let cancelled = false;
    setCodeBuddyModelLoadError("");
    const services = [
      { source: "openrouter" as const, api: window.openRouterApi, label: "OpenRouter" },
      { source: "nararouter" as const, api: window.naraRouterApi, label: "NaraRouter" },
      { source: "minimax" as const, api: window.miniMaxApi, label: "MiniMax" }
    ];
    void Promise.allSettled(services.map(async service => {
      if (!service.api) return [];
      const [config, models] = await Promise.all([service.api.getConfig(), service.api.listModels()]);
      return config.hasApiKey ? models.filter(model => model.agentVerifications?.codebuddy?.status === "passed")
        .map(model => ({ source: service.source as AgentModelSource, id: model.id, name: model.name || model.id })) : [];
    })).then(results => {
      if (cancelled) return;
      setCodeBuddyServiceModels(results.flatMap(result => result.status === "fulfilled" ? result.value : []));
      const failed = results.flatMap((result, index) => result.status === "rejected" ? [services[index].label] : []);
      setCodeBuddyModelLoadError(failed.length ? `${failed.join("、")} 模型读取失败，请重新打开列表重试。` : "");
    });
    return () => { cancelled = true; };
  }, [selectionKind, snapshot.provider, sessionId, sessionType]);
  useEffect(() => {
    if (selectionKind !== "model" || snapshot.provider !== "opencode" || sessionType === "ssh") return;
    let cancelled = false;
    const services = [
      { source: "openrouter", api: window.openRouterApi, label: "OpenRouter" },
      { source: "nararouter", api: window.naraRouterApi, label: "NaraRouter" },
      { source: "minimax", api: window.miniMaxApi, label: "MiniMax" }
    ];
    void Promise.allSettled(services.map(async service => {
      if (!service.api) throw new Error(`${service.label} 模型服务不可用。`);
      const [config, models] = await Promise.all([service.api.getConfig(), service.api.listModels()]);
      return config.hasApiKey ? models.filter(model => model.agentVerifications?.opencode?.status === "passed")
        .map(model => `${service.source}/${model.id}`) : [];
    })).then(results => {
      if (cancelled) return;
      setOpenCodeVerifiedModels({ sessionId, threadId: snapshot.threadId, ids: new Set(results.flatMap(result => result.status === "fulfilled" ? result.value : [])) });
      const failed = results.flatMap((result, index) => result.status === "rejected" ? [services[index].label] : []);
      setOpenCodeModelLoadError(failed.length ? `${failed.join("、")} 模型读取失败，请重新打开列表重试。` : "");
    });
    return () => { cancelled = true; };
  }, [selectionKind, snapshot.provider, snapshot.threadId, sessionId, sessionType]);
  useEffect(() => {
    if (selectionKind !== "model" || snapshot.provider !== "codex" || sessionType === "ssh") return;
    let cancelled = false;
    setCodexModelLoadError("");
    const services = [
      { source: "openrouter" as const, api: window.openRouterApi, label: "OpenRouter" },
      { source: "nararouter" as const, api: window.naraRouterApi, label: "NaraRouter" },
      { source: "minimax" as const, api: window.miniMaxApi, label: "MiniMax" }
    ];
    void Promise.allSettled(services.map(async service => {
      if (!service.api) return [];
      const [config, models] = await Promise.all([service.api.getConfig(), service.api.listModels()]);
      return config.hasApiKey ? models.filter(model => model.compatible && model.verification?.status === "passed")
        .map(model => ({ source: service.source as AgentModelSource, id: model.id, name: model.name || model.id })) : [];
    })).then(results => {
      if (cancelled) return;
      setCodexServiceModels(results.flatMap(result => result.status === "fulfilled" ? result.value : []));
      const failed = results.flatMap((result, index) => result.status === "rejected" ? [services[index].label] : []);
      setCodexModelLoadError(failed.length ? `${failed.join("、")} 模型读取失败，请重新打开列表重试。` : "");
    });
    return () => { cancelled = true; };
  }, [selectionKind, snapshot.provider, sessionId, sessionType]);
  useEffect(() => {
    if (!capabilityOpen || !isActive) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!capabilityRef.current?.contains(event.target as Node) && !menuButtonRef.current?.contains(event.target as Node)) setCapabilityOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [capabilityOpen, isActive]);

  useEffect(() => {
    capabilityRequestRef.current += 1;
    skillWriteRef.current = null;
    setSkillPendingPath(null); setCapabilityLoading(false);
    return () => { capabilityRequestRef.current += 1; skillWriteRef.current = null; };
  }, [sessionId, snapshot.threadId]);
  async function loadCapabilities(refresh = false, saved = false) {
    const threadId = snapshot.threadId;
    const requestId = ++capabilityRequestRef.current;
    const current = () => currentSessionRef.current === sessionId && timelineRef.current?.threadId === threadId
      && capabilityRequestRef.current === requestId;
    setCapabilityLoading(true); setCapabilityError("");
    try {
      const value = await window.codexAppServerApi.listCapabilities(sessionId, refresh);
      if (saved && value.errors.skills) throw new Error(value.errors.skills);
      if (current()) setCapabilities(value);
    } catch (cause) { if (current()) setCapabilityError(`${saved ? "已保存，刷新失败：" : ""}${message(cause)}`); }
    finally { if (current()) setCapabilityLoading(false); }
  }
  async function toggleSkill(skill: CodexSessionCapabilities["skills"][number]) {
    if (skillWriteRef.current) return;
    const operation = {};
    const threadId = snapshot.threadId;
    const current = () => currentSessionRef.current === sessionId && timelineRef.current?.threadId === threadId
      && skillWriteRef.current === operation;
    skillWriteRef.current = operation;
    setSkillPendingPath(skill.path); setCapabilityError("");
    try {
      await window.codexAppServerApi.setSkillEnabled(sessionId, skill.path, !skill.enabled);
      if (current()) await loadCapabilities(true, true);
    } catch (cause) { if (current()) setCapabilityError(message(cause)); }
    finally {
      if (skillWriteRef.current === operation) { skillWriteRef.current = null; setSkillPendingPath(null); }
    }
  }
  function insertCapability(token: string, reference?: CodexCapabilityReference) {
    if (reference && draftReferences.filter(value => draft.includes(value.token) && value.token !== token).length >= 10) {
      setCapabilityError("每条消息最多选择 10 个 Skills 或 Apps。");
      return;
    }
    const input = textareaRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && !/^\s/.test(after) ? " " : "";
    const next = before + prefix + token + suffix + after;
    setDraft(next);
    setDraftReferences(current => {
      const retained = current.filter(value => next.includes(value.token) && value.token !== token);
      return reference ? [...retained, reference] : retained;
    });
    setCapabilityOpen(false);
    window.requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + prefix.length + token.length, start + prefix.length + token.length); });
  }
  function closeFileMention() {
    fileSearchRequestRef.current += 1;
    setFileMention(null);
    setFileResults([]);
    setFileSearchStatus("idle");
    setFileSearchError("");
    setSelectedFileIndex(0);
  }
  function addInlineImage(start: number, end: number, path: string | null) {
    const number = ++imageTokenCounterRef.current;
    const token = `〔图片 ${number}〕`;
    const image = { token, path };
    inlineImagesRef.current = [...inlineImagesRef.current, image];
    setInlineImages(inlineImagesRef.current);
    setDraft(current => current.slice(0, start) + token + current.slice(end));
    window.requestAnimationFrame(() => {
      const caret = start + token.length;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
    return token;
  }
  function changeDraft(next: string) {
    const removed = inlineImagesRef.current.filter(image => !next.includes(image.token));
    if (removed.length) {
      inlineImagesRef.current = inlineImagesRef.current.filter(image => next.includes(image.token));
      setInlineImages(inlineImagesRef.current);
      setAttachments(current => current.filter(filePath => !removed.some(image => image.path === filePath)));
      for (const image of removed) if (image.path && pastedImagesRef.current.delete(image.path))
        void window.codexAppServerApi.discardImage(sessionId, image.path).catch(cause => setError(message(cause)));
    }
    setDraft(next);
  }
  function selectFile(entry: WorkspaceEntrySearchResult) {
    if (!fileMention) return;
    const suffix = entry.type === "directory" ? (sessionType === "windows" ? "\\" : "/") : "";
    const token = `@${entry.relativePath}${suffix} `;
    const next = draft.slice(0, fileMention.start) + token + draft.slice(fileMention.end);
    const caret = fileMention.start + token.length;
    setDraft(next);
    setDraftReferences(current => current.filter(value => next.includes(value.token)));
    closeFileMention();
    window.requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(caret, caret); });
  }

  useEffect(() => { setSideQuestionOpen(false); setSideQuestionInitial(""); }, [sessionId, snapshot.threadId]);
  function openSideQuestion(question = "") {
    setSideQuestionInitial(question); setSideQuestionOpen(true);
  }
  function updateSideQuestion(value: CodexAppServerSnapshot) {
    if (currentSessionRef.current !== sessionId) return;
    setSnapshot(current => {
      if (current.threadId !== value.threadId) return current;
      if (current.sideQuestion?.requestId === value.sideQuestion?.requestId && current.sideQuestion
        && current.sideQuestion.status !== "running" && value.sideQuestion?.status === "running") return current;
      return { ...current, sideQuestion: value.sideQuestion };
    });
  }
  async function submit() {
    if (snapshot.permissionError || snapshot.changingPermission || changingPermissionRef.current) return;
    if (btwMatch && snapshot.threadId) {
      openSideQuestion((btwMatch[1] || "").trim());
      setDraft(""); closeFileMention(); return;
    }

    const submittedDraft = draft;
    const ordered = orderedDraft(draft, inlineImages);
    const text = ordered.text;
    const knownErrorIds = new Set(snapshot.items.filter(item => item.type === "turnError").map(item => item.id));
    if (snapshot.windowsSandboxSetup?.status === "running" || mainAgentPending || snapshot.archived || snapshot.reviewing || snapshot.compacting || forkingTurnId || (!text && attachments.length === 0) || (snapshot.busy && snapshot.provider !== "codex" && snapshot.provider != null)
      || sending || pastingRef.current) return;
    if (!supportsCodexImageInput(timelineRef.current || snapshot) && attachments.some(sendableImageFile)) {
      setError(`${IMAGE_INPUT_UNSUPPORTED}，请先移除图片附件。`); return;
    }
    setSending(true);
    closeFileMention();
    setDraft(""); setError("");
    try {
      const references = draftReferences.filter(value => text.includes(value.token));
      if (inlineImages.length) await window.codexAppServerApi.submit(sessionId, text, attachments, references, ordered.parts);
      else await window.codexAppServerApi.submit(sessionId, text, attachments, references);
      if (currentSessionRef.current === sessionId) { setAttachments([]); setInlineImages([]); inlineImagesRef.current = []; setDraftReferences(current => current.filter(value => !text.includes(value.token))); pastedImagesRef.current.clear(); }
    }
    catch (cause) {
      const recorded = snapshot.provider === "codebuddy" && await hasRecordedCodeBuddyError(sessionId, message(cause), knownErrorIds);
      if (recorded) {
        if (currentSessionRef.current === sessionId) { setAttachments([]); setInlineImages([]); inlineImagesRef.current = []; setDraftReferences(current => current.filter(value => !text.includes(value.token))); pastedImagesRef.current.clear(); }
      } else {
        setDraft(current => current || submittedDraft);
        if (currentSessionRef.current === sessionId) setError(message(cause));
      }
    }
    finally { if (currentSessionRef.current === sessionId) setSending(false); }
  }
  async function loadHistory(cursor: string | null = null, query = "") {
    const requestId = ++historyRequestRef.current;
    const searching = Boolean(query.trim());
    setLoadingHistory(true); setHistorySlow(false); setHistoryError("");
    const slowTimer = window.setTimeout(() => {
      if (currentSessionRef.current === sessionId && historyRequestRef.current === requestId) setHistorySlow(true);
    }, 4000);
    if (!cursor) { setHistory([]); setHistoryCursor(null); }
    try {
      const seenCursors = new Set<string>();
      let nextCursor = cursor;
      do {
        let timeoutId: number | undefined;
        const page = await Promise.race([
          window.codexAppServerApi.listHistory(sessionId, nextCursor, historyArchived),
          new Promise<never>((_resolve, reject) => {
            timeoutId = window.setTimeout(() => reject(new Error("加载历史会话超时，请重试。")), 35000);
          })
        ]).finally(() => window.clearTimeout(timeoutId));
        if (currentSessionRef.current !== sessionId || historyRequestRef.current !== requestId) return;
        const append = Boolean(nextCursor);
        setHistory(current => append ? [...current, ...page.data] : page.data);
        setHistoryCursor(page.nextCursor);
        nextCursor = page.nextCursor;
        if (!searching || !nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
      } while (true);
    } catch (cause) {
      if (currentSessionRef.current === sessionId && historyRequestRef.current === requestId) setHistoryError(message(cause));
    } finally {
      window.clearTimeout(slowTimer);
      if (currentSessionRef.current === sessionId && historyRequestRef.current === requestId) {
        setLoadingHistory(false);
        setHistorySlow(false);
      }
    }
  }
  function closeHistory() {
    setHistoryOpen(false);
    historyRequestRef.current += 1;
    setLoadingHistory(false);
    setHistorySlow(false);
    menuButtonRef.current?.focus();
  }
  async function selectHistory(threadId: string) {
    setResumingHistory(true); setHistoryError("");
    try { const value = await window.codexAppServerApi.resume(sessionId, threadId);
      if (currentSessionRef.current === sessionId) { timelineRef.current = value; setExpandedGroupId(null); setSnapshot(value); closeHistory(); setAttachments([]); setInlineImages([]); inlineImagesRef.current = []; pastedImagesRef.current.clear(); setPreviewFile(null); setDraft(""); setDraftReferences([]); setCapabilities(null); setCapabilityOpen(false); } }
    catch (cause) { if (currentSessionRef.current === sessionId) setHistoryError(message(cause)); }
    finally { if (currentSessionRef.current === sessionId) setResumingHistory(false); }
  }
  async function mutateHistory(threadId: string, action: "rename" | "pin" | "fork" | "delete" | "archive" | "unarchive", value?: string | boolean) {
    const thread = history.find(item => item.id === threadId);
    if (!thread || historyMutation) return;
    if (snapshot.provider === "opencode" && (snapshot.busy || mainAgentPending || sending || pastingImage || resumingHistory
      || snapshot.pendingPlan || snapshot.approvals.length || snapshot.questions?.length)) return;
    if (action === "delete" && (threadId === snapshot.threadId
      || !window.confirm(`删除“${thread.title}”的历史记录？删除后无法在本工具中恢复。`))) return;
    if (action === "archive" && !window.confirm(`归档“${thread.title}”？衍生会话也可能被归档。`)) return;
    setHistoryMutation(threadId); setHistoryError("");
    try {
      if (action === "rename") await window.codexAppServerApi.renameThread(sessionId, threadId, String(value));
      if (action === "delete") await window.codexAppServerApi.deleteThread(sessionId, threadId);
      if (action === "pin") {
        const result = await window.codexAppServerApi.pinThread(sessionId, threadId, Boolean(value));
        if (currentSessionRef.current === sessionId) {
          historyRequestRef.current += 1;
          setLoadingHistory(false);
          setHistoryCursor(null);
          setHistory(current => current.map(item => item.id === threadId ? { ...item, isPinned: result.isPinned } : item));
        }
        return;
      }
      if (action === "archive") await window.codexAppServerApi.archiveThread(sessionId, threadId);
      if (action === "unarchive") await window.codexAppServerApi.unarchiveThread(sessionId, threadId);
      if (action === "fork") {
        const next = await window.codexAppServerApi.forkThread(sessionId, threadId);
        if (currentSessionRef.current === sessionId) {
          timelineRef.current = next; setExpandedGroupId(null); setSnapshot(next);
          setDraft(""); setDraftReferences([]); setAttachments([]); setInlineImages([]); inlineImagesRef.current = []; pastedImagesRef.current.clear(); setPreviewFile(null);
          setCapabilities(null); setCapabilityOpen(false); closeHistory();
        }
      } else if (currentSessionRef.current === sessionId) {
        setRenamingThreadId(null);
        await loadHistory(null, historyQuery);
      }
    } catch (cause) { if (currentSessionRef.current === sessionId) setHistoryError(message(cause)); }
    finally { if (currentSessionRef.current === sessionId) setHistoryMutation(null); }
  }
  async function forkFromTurn(turnId: string) {
    const threadId = snapshot.threadId;
    if (!threadId || !turnId || snapshot.busy || snapshot.archived || forkingTurnId || sending || pastingImage) return;
    setForkingTurnId(turnId); setMenuOpen(false); setError("");
    try {
      const next = await window.codexAppServerApi.forkTurnToNewSession(sessionId, threadId, turnId);
      onSessionCreated?.(next.id);
    } catch (cause) { if (currentSessionRef.current === sessionId) setError(`新建会话失败：${message(cause)}`); }
    finally { if (currentSessionRef.current === sessionId) setForkingTurnId(null); }
  }
  async function confirmRewind() {
    if (!rewindTarget || rewindPending) return;
    setRewindPending(true); setRewindError("");
    try {
      const result = snapshot.provider === "opencode"
        ? { snapshot: await window.codexAppServerApi.revertThread(sessionId, rewindTarget.messageId) }
        : await window.codexAppServerApi.rewind(sessionId, rewindTarget.messageId, rewindScope);
      if (currentSessionRef.current !== sessionId) return;
      timelineRef.current = result.snapshot;
      setSnapshot(result.snapshot);
      setExpandedGroupId(null);
      if (snapshot.provider === "opencode") {
        setRevertedInput(rewindTarget.text);
        if (!rewindDraftRef.current.draft.trim() && !rewindDraftRef.current.hasAttachments) { setDraft(rewindTarget.text); setDraftReferences([]); }
      } else if (rewindScope !== "Code") { setDraft(rewindTarget.text); setDraftReferences([]); }
      setRewindTarget(null);
    } catch (cause) {
      if (currentSessionRef.current === sessionId) {
        setRewindError(message(cause));
        try { setSnapshot(await window.codexAppServerApi.snapshot(sessionId)); } catch {}
      }
    } finally { if (currentSessionRef.current === sessionId) setRewindPending(false); }
  }
  async function restoreOpenCodeRevert() {
    if (rewindPending || snapshot.busy || sending) return;
    setRewindPending(true); setError("");
    try {
      const next = await window.codexAppServerApi.restoreThread(sessionId);
      if (currentSessionRef.current !== sessionId) return;
      timelineRef.current = next; setSnapshot(next);
      setRevertedInput("");
    } catch (cause) {
      if (currentSessionRef.current === sessionId) {
        setError(message(cause));
        try { setSnapshot(await window.codexAppServerApi.snapshot(sessionId)); } catch {}
      }
    } finally { if (currentSessionRef.current === sessionId) setRewindPending(false); }
  }
  async function addFiles() {
    setError("");
    const input = textareaRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? start;
    try { const paths = await window.codexAppServerApi.chooseFiles(sessionId);
      if (currentSessionRef.current === sessionId) {
        const imagesAllowed = supportsCodexImageInput(timelineRef.current || snapshot);
        if (!imagesAllowed && paths.some(sendableImageFile)) setError(IMAGE_INPUT_UNSUPPORTED);
        const added = paths.filter(filePath => (imagesAllowed || !sendableImageFile(filePath)) && !attachments.includes(filePath)).slice(0, Math.max(0, 10 - attachments.length));
        setAttachments(current => [...new Set([...current, ...added])].slice(0, 10));
        let caret = start;
        for (const filePath of added.filter(sendableImageFile)) {
          const token = addInlineImage(caret, caret === start ? end : caret, filePath);
          caret += token.length;
        }
      } }
    catch (cause) { if (currentSessionRef.current === sessionId) setError(message(cause)); }
  }
  async function pasteImage(files: File[] = []) {
    if (!supportsCodexImageInput(timelineRef.current || snapshot)) { setError(IMAGE_INPUT_UNSUPPORTED); return; }
    if (pastingRef.current || (snapshot.busy && snapshot.provider !== "codex" && snapshot.provider != null)
      || sending || !snapshot.threadId) return;
    if (attachments.length >= 10) { setError("最多附加 10 个文件。"); return; }
    pastingRef.current = true;
    setPastingImage(true);
    setError("");
    const input = textareaRef.current;
    let caret = input?.selectionStart ?? draft.length;
    let end = input?.selectionEnd ?? draft.length;
    const available = 10 - attachments.length;
    const errors = files.length > available ? ["最多附加 10 个文件，已跳过超出部分。"] : [];
    try {
      for (const file of files.length ? files.slice(0, available) : [undefined]) {
        if (currentSessionRef.current !== sessionId) break;
        const token = addInlineImage(caret, end, null);
        end = caret;
        try {
          let image: { name: string; bytes: Uint8Array } | undefined;
          if (file) {
            if (!sendableImageFile(file.name)) throw new Error("不支持的图片格式。");
            if (!file.size) throw new Error("图片文件为空或无法读取。");
            if (file.size > 10 * 1024 * 1024) throw new Error("图片文件不能超过 10 MiB。");
            image = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
          }
          const result = image
            ? await window.codexAppServerApi.pasteImage(sessionId, image)
            : await window.codexAppServerApi.pasteImage(sessionId);
          if (result.status === "no_image") throw new Error("剪贴板中没有可用的图片。");
          if (currentSessionRef.current !== sessionId || !inlineImagesRef.current.some(value => value.token === token)) {
            await window.codexAppServerApi.discardImage(sessionId, result.path);
            continue;
          }
          pastedImagesRef.current.add(result.path);
          inlineImagesRef.current = inlineImagesRef.current.map(value => value.token === token ? { ...value, path: result.path } : value);
          setInlineImages(inlineImagesRef.current);
          setAttachments(current => [...current, result.path]);
          caret += token.length;
          end = caret;
        } catch (cause) {
          if (currentSessionRef.current === sessionId) {
            errors.push(file ? `${file.name}：${message(cause)}` : message(cause));
            inlineImagesRef.current = inlineImagesRef.current.filter(value => value.token !== token);
            setInlineImages(inlineImagesRef.current);
            setDraft(current => current.replace(token, ""));
          }
        }
      }
    } finally {
      pastingRef.current = false;
      if (currentSessionRef.current === sessionId) { setPastingImage(false); setError(errors.join("\n")); }
    }
  }
  async function removeAttachment(filePath: string) {
    if (pastedImagesRef.current.has(filePath)) {
      try { await window.codexAppServerApi.discardImage(sessionId, filePath); pastedImagesRef.current.delete(filePath); }
      catch (cause) { setError(message(cause)); return; }
    }
    const image = inlineImagesRef.current.find(value => value.path === filePath);
    if (image) {
      inlineImagesRef.current = inlineImagesRef.current.filter(value => value !== image);
      setInlineImages(inlineImagesRef.current);
      setDraft(current => current.replace(image.token, ""));
    }
    setAttachments(current => current.filter(value => value !== filePath));
  }

  function reportChangeError(cause: unknown) {
    if (currentSessionRef.current !== sessionId) return;
    if (selectionKind) setSelectionError(message(cause));
    else setError(message(cause));
  }
  async function changeMode(mode: "default" | "plan") {
    if (!snapshot.threadId || snapshot.busy || changingModeRef.current || mode === snapshot.mode) return false;
    changingModeRef.current = true;
    setChangingMode(true);
    setError("");
    try {
      const value = await window.codexAppServerApi.setMode(sessionId, mode);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
      return true;
    } catch (cause) {
      reportChangeError(cause);
      return false;
    } finally {
      if (currentSessionRef.current === sessionId) {
        changingModeRef.current = false;
        setChangingMode(false);
      }
    }
  }
  async function changeNativeMode(modeId: string) {
    if (!snapshot.threadId || snapshot.busy || changingModeRef.current || modeId === snapshot.nativeMode) return false;
    changingModeRef.current = true;
    setChangingMode(true); setError("");
    try {
      const value = await window.codexAppServerApi.setNativeMode(sessionId, modeId);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
      return true;
    } catch (cause) { reportChangeError(cause); return false; }
    finally { changingModeRef.current = false; if (currentSessionRef.current === sessionId) setChangingMode(false); }
  }
  async function changePermission(permission: CodexExecutionPermission) {
    if (!snapshot.threadId || snapshot.busy || changingPermissionRef.current || permission === snapshot.executionPermission && !snapshot.permissionProfileId) return false;
    changingPermissionRef.current = true;
    setChangingPermission(true);
    setError("");
    try {
      const value = await window.codexAppServerApi.setExecutionPermission(sessionId, permission);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
      return true;
    } catch (cause) {
      reportChangeError(cause);
      return false;
    } finally {
      if (currentSessionRef.current === sessionId) {
        changingPermissionRef.current = false;
        setChangingPermission(false);
      }
    }
  }
  async function changeModel(modelId: string) {
    if (!snapshot.threadId || snapshot.busy || sending || changingModelRef.current || modelId === snapshot.model) return false;
    changingModelRef.current = true;
    setChangingModel(true);
    setError("");
    try {
      const value = await window.codexAppServerApi.setModel(sessionId, modelId);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
      return true;
    } catch (cause) { reportChangeError(cause); return false; }
    finally { if (currentSessionRef.current === sessionId) { changingModelRef.current = false; setChangingModel(false); } }
  }
  async function changeCodeBuddyListedModel(value: string) {
    if (snapshot.busy || sending || changingModelRef.current) return false;
    const separator = value.indexOf(":");
    const source = value.slice(0, separator) as AgentModelSource;
    const modelId = value.slice(separator + 1);
    if (source === "native" && (!session?.modelSource || session.modelSource === "native")) return changeModel(modelId);
    if (!onSwitchCodeBuddyModel) return false;
    changingModelRef.current = true;
    setChangingModel(true);
    try {
      await onSwitchCodeBuddyModel(sessionId, source, modelId || undefined);
      return true;
    } catch (cause) { reportChangeError(cause); return false; }
    finally { changingModelRef.current = false; setChangingModel(false); }
  }
  async function changeCodexListedModel(value: string) {
    if (!snapshot.threadId || snapshot.busy || sending || changingModelRef.current) return false;
    const separator = value.indexOf(":");
    const source = value.slice(0, separator) as AgentModelSource;
    const modelId = value.slice(separator + 1);
    if (source === "native" && snapshot.backend === "openai") return changeModel(modelId);
    if (!onSwitchCodexModel) return false;
    changingModelRef.current = true;
    setChangingModel(true);
    setError("");
    try {
      await onSwitchCodexModel(sessionId, source, modelId || undefined);
      return true;
    } catch (cause) { reportChangeError(cause); return false; }
    finally { changingModelRef.current = false; setChangingModel(false); }
  }
  async function changeEffort(effort: string) {
    if (!snapshot.threadId || snapshot.busy || sending || changingModelRef.current || attachments.length || effort === snapshot.effort) return false;
    changingModelRef.current = true;
    setChangingModel(true);
    setError("");
    try {
      const value = await window.codexAppServerApi.setEffort(sessionId, effort);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
      return true;
    } catch (cause) { reportChangeError(cause); return false; }
    finally { if (currentSessionRef.current === sessionId) { changingModelRef.current = false; setChangingModel(false); } }
  }
  async function changeContextWindow(value: string) {
    if (!snapshot.threadId || snapshot.busy || changingModelRef.current) return false;
    changingModelRef.current = true;
    setChangingModel(true);
    setError("");
    try {
      const next = await window.codexAppServerApi.setContextWindow(sessionId, value);
      if (currentSessionRef.current === sessionId) setSnapshot(next);
      return true;
    } catch (cause) { reportChangeError(cause); return false; }
    finally { changingModelRef.current = false; if (currentSessionRef.current === sessionId) setChangingModel(false); }
  }
  async function loadMainAgents() {
    const threadId = snapshot.threadId;
    setMainAgentLoading(true);
    try {
      const next = await window.codexAppServerApi.listMainAgents(sessionId);
      if (currentSessionRef.current === sessionId && timelineRef.current?.threadId === threadId) setSnapshot(next);
    } catch (cause) { reportChangeError(cause); }
    finally { if (currentSessionRef.current === sessionId) setMainAgentLoading(false); }
  }
  async function changeMainAgent(agentName: string) {
    try {
      const next = await window.codexAppServerApi.setMainAgent(sessionId, agentName);
      if (currentSessionRef.current === sessionId) setSnapshot(next);
      return true;
    } catch (cause) { reportChangeError(cause); return false; }
  }
  async function changeMultitask(enabled: boolean) {
    if (!snapshot.threadId || changingMultitask) return false;
    setChangingMultitask(true); setError("");
    try {
      const value = await window.codexAppServerApi.setMultitask(sessionId, enabled);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
      return true;
    } catch (cause) { reportChangeError(cause); return false; }
    finally { if (currentSessionRef.current === sessionId) setChangingMultitask(false); }
  }
  async function sendMemberMessage() {
    const teamName = snapshot.team?.name;
    const memberName = selectedMemberName || snapshot.team?.members[0]?.name;
    const content = memberDraft.trim();
    if (!snapshot.threadId || !teamName || !memberName || !content || sendingMember) return;
    setSendingMember(true); setMemberError("");
    try {
      await window.codexAppServerApi.sendTeamMessage(sessionId, teamName, memberName, content);
      if (currentSessionRef.current === sessionId && timelineRef.current?.threadId === snapshot.threadId
        && timelineRef.current?.team?.name === teamName) setMemberDraft("");
    } catch (cause) { if (currentSessionRef.current === sessionId) setMemberError(message(cause)); }
    finally { if (currentSessionRef.current === sessionId) setSendingMember(false); }
  }
  async function changeFastMode(enabled: boolean) {
    if (!snapshot.threadId || snapshot.busy || sending || changingModelRef.current || attachments.length || enabled === snapshot.fastMode) return false;
    changingModelRef.current = true;
    setChangingModel(true);
    setError("");
    try {
      const value = await window.codexAppServerApi.setFastMode(sessionId, enabled);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
      return true;
    } catch (cause) { reportChangeError(cause); return false; }
    finally { if (currentSessionRef.current === sessionId) { changingModelRef.current = false; setChangingModel(false); } }
  }
  async function resolvePlan(itemId: string, execute: boolean) {
    if (resolvingPlanRef.current || snapshot.provider === "opencode" && changingModeRef.current
      || (snapshot.busy && snapshot.provider !== "codebuddy")
      || (snapshot.provider === "opencode" ? !execute || openCodePlanReplyId(snapshot) !== itemId
        : snapshot.pendingPlan?.itemId !== itemId)) return;
    resolvingPlanRef.current = true;
    setResolvingPlan(true);
    setError("");
    try {
      if (execute) await window.codexAppServerApi.executePlan(sessionId, itemId);
      else {
        const value = await window.codexAppServerApi.dismissPlan(sessionId, itemId);
        if (currentSessionRef.current === sessionId) setSnapshot(value);
      }
    } catch (cause) { if (currentSessionRef.current === sessionId) setError(message(cause)); }
    finally {
      if (currentSessionRef.current === sessionId) {
        resolvingPlanRef.current = false;
        setResolvingPlan(false);
      }
    }
  }

  const normalizedHistoryQuery = historyQuery.trim().toLocaleLowerCase();
  const visibleHistory = (normalizedHistoryQuery
    ? history.filter(thread => `${thread.title} ${thread.id}`.toLocaleLowerCase().includes(normalizedHistoryQuery))
    : [...history]).sort((a, b) => Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned)) || b.updatedAt - a.updatedAt);

  const agentName = snapshot.provider === "codebuddy" ? "CodeBuddy" : snapshot.provider === "opencode" ? "OpenCode" : snapshot.provider === "claude" ? "Claude" : snapshot.provider === "qoder" ? "Qoder" : snapshot.provider === "gemini" ? "Gemini" : snapshot.provider === "grok" ? "Grok" : "Codex";
  const canSendWhileBusy = agentName === "Codex" && !snapshot.compacting && !snapshot.reviewing;
  const acpModel = snapshot.provider === "codebuddy" && session?.modelSource && session.modelSource !== "native" ? undefined
    : snapshot.provider === "opencode" || snapshot.provider === "codebuddy" || snapshot.provider === "claude" || snapshot.provider === "qoder" || snapshot.provider === "gemini" || snapshot.provider === "grok"
    ? snapshot.acpOptions?.find(option => option.id === "model" && option.type === "select" && option.options?.length) : undefined;
  const modelDetails = (modelId: string) => {
    if (snapshot.provider !== "codebuddy") return "";
    const metadata = modelMetadata.find(model => model.id === modelId);
    return [metadata?.creditMultiplier ? `倍率 ${metadata.creditMultiplier}` : "", ...(metadata?.promotions.map(promotion => promotion.label) || [])].filter(Boolean).join(" · ");
  };
  const acpEffort = snapshot.provider === "opencode" || snapshot.provider === "claude" || snapshot.provider === "qoder" ? snapshot.acpOptions?.find(option => option.id === (snapshot.provider === "qoder" ? "reasoning_effort" : "effort") && option.type === "select") : undefined;
  const acpContextWindow = snapshot.provider === "codebuddy" ? snapshot.acpOptions?.find(option => option.id === "context_window" && option.type === "select" && (option.options?.length ?? 0) > 1) : undefined;
  const multitaskOption = snapshot.provider === "codebuddy" && snapshot.capabilities?.multitask === true
    ? snapshot.acpOptions?.find(option => option.id === "multitask" && option.type === "boolean") : undefined;
  const mainAgent = snapshot.provider === "codebuddy" ? snapshot.mainAgent : null;
  const mainAgentLabel = mainAgent?.agents.find(agent => agent.name === mainAgent.currentAgentName)?.displayName || mainAgent?.currentAgentName || "未读取";
  const isAcp = snapshot.provider === "codebuddy" || snapshot.provider === "opencode" || snapshot.provider === "claude" || snapshot.provider === "qoder" || snapshot.provider === "gemini" || snapshot.provider === "grok";
  const currentModel = (snapshot.models || []).find(model => model.id === snapshot.model);
  const codeBuddyUnifiedModel = snapshot.provider === "codebuddy" && sessionType !== "ssh" && Boolean(onSwitchCodeBuddyModel);
  const codexUnifiedModel = snapshot.provider === "codex" && sessionType !== "ssh" && Boolean(onSwitchCodexModel);
  const codexCurrentSource = session?.modelSource || "native";
  const codexCurrentName = codexCurrentSource === "native"
    ? currentModel?.displayName || snapshot.model || "原生模型"
    : codexServiceModels.find(model => model.source === codexCurrentSource && model.id === session?.modelId)?.name || session?.modelId || "服务模型";
  const codeBuddyCurrentSource = session?.modelSource || "native";
  const codeBuddyCurrentName = codeBuddyCurrentSource === "native"
    ? acpModel?.options?.find(option => option.value === acpModel.currentValue)?.name || acpModel?.currentValue || "原生模型"
    : codeBuddyServiceModels.find(model => model.source === codeBuddyCurrentSource && model.id === session?.modelId)?.name || session?.modelId || "服务模型";
  const openCodeAllowedModels = openCodeVerifiedModels?.sessionId === sessionId && openCodeVerifiedModels.threadId === snapshot.threadId
    ? openCodeVerifiedModels.ids : null;
  const visibleAcpModels = snapshot.provider === "opencode" && sessionType !== "ssh"
    ? (acpModel?.options || []).filter(option => {
      const source = option.value.split("/", 1)[0];
      return ["openrouter", "nararouter", "minimax"].includes(source) && Boolean(openCodeAllowedModels?.has(option.value));
    }) : acpModel?.options || [];
  const selectionTitles: Record<SelectionKind, string> = {
    mode: isAcp ? `${agentName} 模式` : "模式", model: "模型", effort: "思考强度",
    fastMode: "快速模式", permission: "执行权限", contextWindow: "上下文窗口", multitask: "Multitask", mainAgent: "主 Agent"
  };
  type SelectionOption = { value: string; label: string; description?: string; selected: boolean; disabled?: boolean };
  const selectionOptions: SelectionOption[] = selectionKind === "mainAgent"
    ? (mainAgent?.agents || []).map(agent => {
      const conflict = agent.name === "minimal" && (snapshot.nativeMode === "plan" || multitaskOption?.currentValue === true);
      return { value: agent.name, label: agent.displayName,
        description: [agent.source === "built-in" ? codeBuddyMainAgentDescriptions[agent.name] || agent.description : agent.description,
          ({ "built-in": "内置", user: "用户", project: "项目" } as Record<string, string>)[agent.source || ""] || agent.source,
          agent.broken, conflict ? "请先退出 Plan 并关闭 Multitask" : ""].filter(Boolean).join(" · "),
        selected: mainAgent?.currentAgentName === agent.name,
        disabled: snapshot.busy || sending || resumingHistory || mainAgentLoading || !mainAgent?.sessionBlank || Boolean(mainAgent?.error || agent.broken || conflict) };
    })
    : selectionKind === "mode"
    ? isAcp ? (snapshot.nativeModes || []).map(mode => {
      const translation = snapshot.provider === "codebuddy"
        ? (codeBuddyModeDescriptions[normalizeModeKey(mode.id)] || codeBuddyModeDescriptions[normalizeModeKey(mode.name)])
        : undefined;
      return {
        value: mode.id,
        label: mode.name,
        description: snapshot.provider === "codebuddy" ? (translation ?? mode.description) : mode.description,
        selected: snapshot.nativeMode === mode.id,
        disabled: snapshot.busy || changingMode
      };
    })
      : [{ value: "default", label: "Exec", selected: snapshot.mode === "default", disabled: snapshot.busy || changingMode },
        { value: "plan", label: "Plan", selected: snapshot.mode === "plan", disabled: snapshot.busy || changingMode || snapshot.capabilities?.plan === false }]
    : selectionKind === "model"
      ? codexUnifiedModel ? [
        ...(snapshot.backend === "openai" ? (snapshot.models || []).map(model => ({ value: `native:${model.id}`, label: `OpenAI · ${model.displayName}`,
          selected: snapshot.model === model.id, disabled: snapshot.busy || sending || changingModel || attachments.length > 0 }))
          : [{ value: "native:", label: "OpenAI · 原生模型", description: "切换后可选择原生模型", selected: false,
            disabled: snapshot.busy || sending || changingModel }]),
        ...codexServiceModels.map(model => ({ value: `${model.source}:${model.id}`,
          label: `${model.source === "openrouter" ? "OpenRouter" : model.source === "nararouter" ? "NaraRouter" : "MiniMax"} · ${model.name}`,
          description: model.id, selected: codexCurrentSource === model.source && session?.modelId === model.id,
          disabled: snapshot.busy || sending || changingModel }))]
        : codeBuddyUnifiedModel ? [
        ...(acpModel?.options || []).map(option => ({ value: `native:${option.value}`, label: `原生 · ${option.name}`,
          description: modelDetails(option.value), selected: codeBuddyCurrentSource === "native" && acpModel?.currentValue === option.value,
          disabled: snapshot.busy || changingModel })),
        ...(!acpModel && codeBuddyCurrentSource !== "native" ? [{ value: "native:", label: "原生模型", description: "切换后可选择原生模型",
          selected: false, disabled: snapshot.busy || changingModel }] : []),
        ...codeBuddyServiceModels.map(model => ({ value: `${model.source}:${model.id}`, label: `${model.source === "openrouter" ? "OpenRouter" : model.source === "nararouter" ? "NaraRouter" : "MiniMax"} · ${model.name}`,
          description: model.id, selected: codeBuddyCurrentSource === model.source && session?.modelId === model.id,
          disabled: snapshot.busy || changingModel }))]
        : acpModel ? visibleAcpModels.map(option => ({ value: option.value, label: option.name,
        description: modelDetails(option.value), selected: acpModel.currentValue === option.value, disabled: snapshot.busy || changingModel }))
        : (snapshot.models || []).map(model => ({ value: model.id, label: model.displayName, selected: snapshot.model === model.id,
          disabled: snapshot.busy || sending || changingModel || attachments.length > 0 }))
    : selectionKind === "effort"
      ? acpEffort ? (acpEffort.options || []).map(option => ({ value: option.value, label: option.name,
        selected: acpEffort.currentValue === option.value, disabled: snapshot.busy || changingModel }))
        : (currentModel?.supportedReasoningEfforts || []).map(option => ({ value: option.reasoningEffort,
          label: effortLabel(option.reasoningEffort), description: option.description || undefined,
          selected: snapshot.effort === option.reasoningEffort, disabled: snapshot.busy || sending || changingModel || attachments.length > 0 }))
    : selectionKind === "fastMode" ? [false, true].map(value => ({ value: String(value), label: value ? "开启" : "关闭",
      description: value ? "用量成本更高" : undefined, selected: Boolean(snapshot.fastMode) === value,
      disabled: snapshot.busy || sending || changingModel || attachments.length > 0 || !currentModel?.fastAvailable }))
    : selectionKind === "permission" ? (["readOnly", "askApproval", "fullAccess"] as const).map(value => ({ value,
      label: permissionLabels[value], description: snapshot.permissionOptions?.find(option => option.id === value)?.reason || permissionDescriptions[value], selected: !snapshot.permissionProfileId && snapshot.executionPermission === value,
      disabled: snapshot.permissionOptions?.some(option => option.id === value && !option.allowed) || snapshot.busy || changingPermission || snapshot.changingPermission || Boolean(snapshot.capabilities?.supportedPermissions && !snapshot.capabilities.supportedPermissions.includes(value)) }))
    : selectionKind === "contextWindow" ? (acpContextWindow?.options || []).map(option => ({ value: option.value,
      label: option.name, selected: acpContextWindow?.currentValue === option.value, disabled: snapshot.busy || changingModel }))
    : selectionKind === "multitask" ? [false, true].map(value => ({ value: String(value), label: value ? "开启" : "关闭",
      selected: multitaskOption?.currentValue === value, disabled: snapshot.busy || changingMultitask })) : [];
  const selectionNextTurn = selectionKind === "model" || selectionKind === "effort" || selectionKind === "fastMode"
    || selectionKind === "permission" || selectionKind === "contextWindow";
  function openSelection(kind: SelectionKind) {
    setMenuOpen(false); setSelectionError("");
    if (kind === "model" && snapshot.provider === "opencode") { setOpenCodeVerifiedModels(null); setOpenCodeModelLoadError(""); }
    setSelectionKind(kind);
    if (kind === "mainAgent") void loadMainAgents();
  }
  function openCapabilities(tab: "skills" | "apps" | "mcp") {
    setMenuOpen(false); setCapabilityTab(tab); setCapabilityQuery(""); setCapabilityOpen(true);
    void loadCapabilities(isCodex);
  }
  function openHistory() { setMenuOpen(false); setHistoryQuery(""); setCopyNotice(null); setHistoryOpen(true); }
  function openGoal() {
    setMenuOpen(false); setGoalOpen(true);
    void window.codexAppServerApi.getGoal(sessionId).catch(cause => {
      if (currentSessionRef.current === sessionId) setError(message(cause));
    });
  }
  function compactConversation() {
    setMenuOpen(false); setError("");
    void window.codexAppServerApi.compactThread(sessionId).catch(cause => {
      if (currentSessionRef.current === sessionId) setError(message(cause));
    });
  }
  function startNewConversation() {
    void window.codexAppServerApi.newThread(sessionId)
      .then(value => { if (currentSessionRef.current === sessionId) { timelineRef.current = value; setExpandedGroupId(null); setSnapshot(value); setDraft(""); setDraftReferences([]); setAttachments([]); setInlineImages([]); inlineImagesRef.current = []; pastedImagesRef.current.clear(); setPreviewFile(null); setHistoryOpen(false); setCapabilities(null); setCapabilityOpen(false); } })
      .catch(cause => { if (currentSessionRef.current === sessionId) setError(message(cause)); });
  }
  function closeSelection() { if (selectionPending) return; setSelectionKind(null); setSelectionError(""); menuButtonRef.current?.focus(); }
  async function selectOption(value: string) {
    if (!selectionKind || selectionPending) return;
    const selected = selectionOptions.find(option => option.value === value);
    if (!selected || selected.disabled || selected.selected) return;
    const kind = selectionKind;
    setSelectionPending(true); setSelectionError("");
    let succeeded = false;
    try {
      if (kind === "mainAgent") succeeded = await changeMainAgent(value);
      else if (kind === "mode") succeeded = isAcp ? await changeNativeMode(value) : await changeMode(value as "default" | "plan");
      else if (kind === "model") succeeded = codexUnifiedModel ? await changeCodexListedModel(value) : codeBuddyUnifiedModel ? await changeCodeBuddyListedModel(value) : await changeModel(value);
      else if (kind === "effort") succeeded = await changeEffort(value);
      else if (kind === "fastMode") succeeded = await changeFastMode(value === "true");
      else if (kind === "permission") succeeded = await changePermission(value as CodexExecutionPermission);
      else if (kind === "contextWindow") succeeded = await changeContextWindow(value);
      else succeeded = await changeMultitask(value === "true");
      if (succeeded && currentSessionRef.current === sessionId) { setSelectionKind(null); menuButtonRef.current?.focus(); }
    } finally { if (currentSessionRef.current === sessionId) setSelectionPending(false); }
  }
  const isCodex = !snapshot.provider || snapshot.provider === "codex";
  const sandboxSettingUp = snapshot.windowsSandboxSetup?.status === "running";
  const canManageCodeBuddyPlugins = snapshot.provider === "codebuddy" && sessionType === "windows";
  const canManageCodeBuddyJobs = snapshot.provider === "codebuddy" && sessionType === "windows";
  const isOpenCode = snapshot.provider === "opencode";
  const versionProvider = snapshot.provider === "codebuddy" ? "codebuddy"
    : snapshot.provider === "opencode" ? "opencode"
    : isCodex ? "codex" : null;
  const canCheckVersion = Boolean(snapshot.threadId && versionProvider
    && (!session || session.runtimeMode === "app-server" && session.agentProvider === versionProvider));
  const imagesAllowed = supportsCodexImageInput(snapshot);
  const canAttach = (!snapshot.busy || canSendWhileBusy) && !sending && !pastingImage && attachments.length < 10;
  const reviewDisabled = !snapshot.threadId || snapshot.busy || mainAgentPending || sending || pastingImage || Boolean(snapshot.archived) || snapshot.account?.status === "signedOut";
  function openReview() { if (!reviewDisabled) { setMenuOpen(false); setReviewOpen(true); } }
  const localSlashCommands: SlashCommand[] = [
    { id: "new", label: "新对话", disabled: snapshot.busy || mainAgentPending || sending || pastingImage },
    { id: "history", label: "历史会话", disabled: snapshot.busy || snapshot.capabilities?.history === false },
    ...(isCodex ? [
      { id: "skills", label: "Skills 列表" }, { id: "apps", label: "Apps 列表" }, { id: "mcp", label: "MCP 列表" },
      { id: "background", label: "后台终端", disabled: !snapshot.threadId },
      { id: "compact", label: "压缩对话", disabled: snapshot.busy || sending },
      { id: "review", label: "代码审查", disabled: reviewDisabled },
      { id: "goal", label: "目标管理" }
    ] : snapshot.provider === "codebuddy" ? [{ id: "goal", label: "目标管理" }] : []),
    ...(isCodex || canManageCodeBuddyPlugins ? [{ id: "plugins", label: "插件管理" }] : []),
    ...(canAskSideQuestion ? [{ id: "btw", label: "独立旁问", disabled: !snapshot.threadId }] : []),
    ...(canManageCodeBuddyJobs ? [{ id: "codeBuddyJobs", label: "后台智能体" }] : []),
    { id: "mode", label: "模式" },
    ...(mainAgent ? [{ id: "mainAgent", label: "主 Agent" }] : []),
    ...(multitaskOption ? [{ id: "multitask", label: "Multitask" }] : []),
    ...(acpModel || codeBuddyUnifiedModel || codexUnifiedModel || (!isAcp && snapshot.backend === "openai") ? [{ id: "model", label: "模型" }] : []),
    ...(acpContextWindow ? [{ id: "contextWindow", label: "上下文窗口" }] : []),
    ...(acpEffort || (!isAcp && snapshot.backend === "openai" && Boolean(currentModel?.supportedReasoningEfforts?.length)) ? [{ id: "effort", label: "思考强度" }] : []),
    ...(!isAcp && snapshot.backend === "openai" ? [{ id: "fastMode", label: "快速模式" }] : []),
    ...(!isAcp ? [{ id: "permission", label: "执行权限" }] : []),
    { id: "files", label: "附加文件", disabled: !canAttach }
  ];
  const localCommandNames = new Set(localSlashCommands.map(command => command.id.toLocaleLowerCase()));
  const slashCommands: SlashCommand[] = snapshot.provider === "codebuddy" || snapshot.provider === "opencode" || snapshot.provider === "qoder" || snapshot.provider === "gemini" || snapshot.provider === "grok"
    ? [...localSlashCommands, ...(snapshot.availableCommands || [])
      .filter(command => !localCommandNames.has(command.name.toLocaleLowerCase()))
      .map(command => ({ id: command.name, label: command.description || `${agentName} 命令`, source: snapshot.provider === "opencode" ? "opencode" as const : snapshot.provider === "qoder" ? "qoder" as const : snapshot.provider === "gemini" ? "gemini" as const : snapshot.provider === "grok" ? "grok" as const : "codebuddy" as const }))]
    : localSlashCommands;
  const slashQuery = !slashDismissed && /^\/[^\s]*$/.test(draft) ? draft.slice(1).toLocaleLowerCase() : null;
  const visibleSlashCommands = slashQuery === null ? [] : slashCommands.filter(command => `${command.id} ${command.label}`.toLocaleLowerCase().includes(slashQuery));
  function executeSlashCommand(command: SlashCommand) {
    if (command.disabled) return;
    if (command.source === "codebuddy" || command.source === "opencode" || command.source === "qoder" || command.source === "gemini" || command.source === "grok") {
      setSlashDismissed(true); setSelectedSlashIndex(0);
      setDraft(`/${command.id} `);
      window.requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    setSlashDismissed(true); setSelectedSlashIndex(0); setDraft("");
    if (command.id === "btw") openSideQuestion();
    else if (command.id === "new") startNewConversation();
    else if (command.id === "history") openHistory();
    else if (command.id === "skills" || command.id === "apps" || command.id === "mcp") openCapabilities(command.id);
    else if (command.id === "plugins") setPluginOpen(true);
    else if (command.id === "background") setBackgroundTerminalsOpen(true);
    else if (command.id === "codeBuddyJobs") setCodeBuddyJobsOpen(true);
    else if (command.id === "compact") compactConversation();
    else if (command.id === "review") openReview();
    else if (command.id === "goal") openGoal();
    else if (command.id === "files") void addFiles();
    else openSelection(command.id as SelectionKind);
  }
  const matchesCapability = (name: string, description: string) => `${name} ${description}`.toLocaleLowerCase().includes(capabilityQuery.trim().toLocaleLowerCase());
  const selectedMember = snapshot.team?.members.find(member => member.name === selectedMemberName) || snapshot.team?.members[0];
  const timeline = useMemo(() => {
    const entries = isActive ? groupTimeline(snapshot, minimalMode) : [];
    if (snapshot.provider && snapshot.provider !== "codex") return entries;
    const userTurns = new Set(snapshot.items.filter(item => item.type === "userMessage" && item.turnId).map(item => item.turnId));
    const activeTurnId = snapshot.busy ? [...snapshot.items].reverse().find(item => item.turnId)?.turnId : null;
    const lastIndex = new Map<string, number>();
    const turnIdOf = (entry: typeof entries[number]) => entry.kind === "tools" ? entry.items.at(-1)?.turnId
      : entry.kind === "item" ? entry.item.turnId : entry.kind === "diff" ? entry.diff.turnId : entry.event.turnId;
    entries.forEach((entry, index) => { const turnId = turnIdOf(entry); if (turnId) lastIndex.set(turnId, index); });
    return entries.flatMap((entry, index) => {
      const turnId = turnIdOf(entry);
      return turnId && turnId !== activeTurnId && userTurns.has(turnId) && lastIndex.get(turnId) === index
        ? [entry, { kind: "forkTurn" as const, turnId }] : [entry];
    });
  }, [isActive, snapshot, minimalMode]);
  const openCodePlanItemId = openCodePlanReplyId(snapshot);
  const openCodeBuildMode = snapshot.nativeModes?.find(mode => normalizeModeKey(mode.id) === "build");
  return <CodeBuddyMcpAppContext.Provider value={{ sessionId, threadId: snapshot.threadId || "",
    enabled: snapshot.provider === "codebuddy" && sessionType === "windows" && Boolean(snapshot.threadId),
    fillMessage: async (itemId, content) => {
      const threadId = snapshot.threadId;
      if (!threadId || currentSessionRef.current !== sessionId || timelineRef.current?.threadId !== threadId) throw new Error("对话已切换。");
      if (content.some(part => part.type !== "text" && part.type !== "image")) throw new Error("仅支持文本和图片回填。");
      const images = content.filter(part => part.type === "image").map(part => ({ data: part.data || "", mimeType: part.mimeType || "" }));
      if (attachments.length + images.length > 10) throw new Error("最多附加 10 个文件。");
      const files = images.length ? await window.codeBuddyMcpApi.images(sessionId, threadId, itemId, images) : [];
      if (currentSessionRef.current !== sessionId || timelineRef.current?.threadId !== threadId) {
        await Promise.allSettled(files.map(file => window.codexAppServerApi.discardImage(sessionId, file)));
        throw new Error("对话已切换。");
      }
      for (const file of files) pastedImagesRef.current.add(file);
      setAttachments(current => [...current, ...files]);
      const text = content.filter(part => part.type === "text").map(part => part.text || "").join("\n");
      setDraft(draft ? `${draft}\n${text}` : text);
      textareaRef.current?.focus();
    }
  }}><section className="codex-app-server-session" aria-label={`${agentName} 图形会话`}>
    {isCodex && (snapshot.backend || "openai") === "openai" && snapshot.account?.status === "signedOut" && <CodexAccountPanel key={sessionId} account={snapshot.account} preferDeviceCode={sessionType !== "windows"} busy={snapshot.busy} actions={{
      readAccount: () => window.codexAppServerApi.readAccount(sessionId),
      startLogin: type => window.codexAppServerApi.startLogin(sessionId, type),
      cancelLogin: () => window.codexAppServerApi.cancelLogin(sessionId),
      logout: () => window.codexAppServerApi.logout(sessionId),
      refreshAccountUsage: () => window.codexAppServerApi.refreshAccountUsage(sessionId)
    }} />}
    <div className={`codex-app-server-conversation-layout${(snapshot.provider === "codebuddy" && snapshot.team || isCodex && snapshot.subAgents?.members.length && snapshot.subAgents.expanded) ? " has-team" : ""}`}>
      <div className="codex-app-server-main-pane">
    {snapshot.provider === "codebuddy" && snapshot.team && <div className="codex-app-server-pane-heading">团队领导 · {snapshot.team.name || "团队加载中"}{snapshot.team.isAutoTeam ? " · 自动团队" : ""}</div>}
    <div ref={messagesRef} className="codex-app-server-messages" aria-live="polite" onScroll={event => {
      if (!isActive) return;
      const messages = event.currentTarget;
      followMessagesRef.current = messages.scrollHeight - messages.clientHeight - messages.scrollTop <= 32;
      if (isCompleted) completedScrollRef.current = { sessionId, threadId: snapshot.threadId, top: messages.scrollTop };
    }}>
      {snapshot.items.length === 0 && !snapshot.busy && <div className="codex-app-server-empty"><div className="codex-app-server-empty-welcome"><span className="codex-app-server-empty-icon"><Sparkles aria-hidden="true" /></span><h2>我是 {agentName}，有什么需要完成？</h2></div>{canCheckVersion && <CodexVersionControl key={`${sessionId}:${snapshot.threadId}:${versionProvider}`} sessionId={sessionId} provider={versionProvider!} />}</div>}
      {timeline.map(entry => {
        if (entry.kind === "forkTurn") return <div className="codex-app-server-turn-actions" key={`fork-${entry.turnId}`}>
          <button type="button" disabled={snapshot.busy || snapshot.archived || Boolean(forkingTurnId) || sending || pastingImage}
            onClick={() => void forkFromTurn(entry.turnId)}>{forkingTurnId === entry.turnId ? "正在新建会话…" : "从此回合新建会话"}</button>
        </div>;
        if (entry.kind === "diagnostic") return <DiagnosticCard key={`diagnostic-${entry.event.id}`} event={entry.event} sessionId={sessionId} templateId={session?.templateId} />;
        if (entry.kind === "diff") return <TurnDiffCard key={`diff-${entry.diff.turnId}`} diff={entry.diff} />;
        if (entry.kind === "tools") {
          const groupId = entry.items[0].id;
          return <ToolGroup key={groupId} items={entry.items} codeBuddy={snapshot.provider === "codebuddy"} expanded={expandedGroupId === groupId}
            onToggle={() => setExpandedGroupId(current => current === groupId ? null : groupId)} />;
        }
        const item = entry.item;
        if (item.type === "backgroundTurn") return <div className="codex-app-server-background-turn" key={item.id} role="status">后台任务汇总</div>;
        if (item.type === "turnError") return <article className="codex-app-server-message turn-error" key={item.id} role="alert">
          <strong>CodeBuddy 运行错误</strong><p>{item.text}</p>
        </article>;
        if (item.type === "userMessage" || item.type === "agentMessage" || item.type === "plan") return <article className={`codex-app-server-message graphical-message-copyable ${timelineItemClass(item.type)}`} key={item.id}>
          <GraphicalMessageCopy text={graphicalMessageText(item)} />
          {item.type === "plan" && <strong>计划</strong>}
          {item.type === "userMessage" ? <>{item.parts?.length ? item.parts.map((part, index) => part.type === "text"
            ? <p key={`text-${index}`}>{part.text}</p>
            : <div className="codex-app-server-attachments" key={`image-${index}`}><AttachmentTile sessionId={sessionId}
                file={{ path: part.path, name: part.name }} onPreview={() => setPreviewFile({ path: part.path, name: part.name })} /></div>)
            : item.text && <p>{item.text}</p>}{Boolean(item.attachments?.length) &&
            <div className="codex-app-server-attachments">{item.attachments?.filter(file => !item.parts?.some(part => part.type === "image" && part.path === file.path))
              .map(file => <AttachmentTile key={file.path} sessionId={sessionId} file={file} onPreview={() => setPreviewFile(file)} />)}</div>}</>
            : item.text && <MarkdownBlock className="codex-app-server-markdown" content={item.text} externalLinks={!onLinkClick} onLinkClick={onLinkClick} linkActions />}
          {snapshot.pendingPlan?.itemId === item.id && <div className="codex-app-server-plan-confirm" role="group" aria-label="确认执行计划">
            <p>{snapshot.provider === "codebuddy" ? "确认后将允许请求方执行此计划。" : "计划已完成。确认后将在当前会话中执行。"}</p>
            <div><button type="button" disabled={resolvingPlan} onClick={() => void resolvePlan(item.id, false)}>{snapshot.provider === "codebuddy" ? "继续修改" : "暂不执行"}</button>
              <button type="button" className="primary" disabled={resolvingPlan} onClick={() => void resolvePlan(item.id, true)}>执行计划</button></div>
          </div>}
          {openCodePlanItemId === item.id && openCodeBuildMode && <div className="codex-app-server-plan-confirm">
            <button type="button" className="primary" disabled={resolvingPlan || changingMode} onClick={() => void resolvePlan(item.id, true)}>执行计划</button>
          </div>}
          {item.type === "userMessage" && ((snapshot.provider === "codebuddy" && sessionType === "windows" && snapshot.capabilities?.rewind) || (snapshot.provider === "opencode" && snapshot.capabilities?.revertHistory)) && item.rewindMessageId &&
            <button type="button" disabled={snapshot.busy || sending || rewindPending || Boolean(snapshot.pendingPlan || snapshot.approvals.length || snapshot.questions?.length)} onClick={() => {
              setRewindTarget({ messageId: item.rewindMessageId!, text: item.text || "" });
              setRewindScope("CodeAndConversation"); setRewindError("");
            }}>回退到此处</button>}
        </article>;
        if (item.type === "turnPlan") return <article className="codex-app-server-message turn-plan" key={item.id}>
          <strong>计划进度</strong>
          {item.explanation && <p>{item.explanation}</p>}
          <ol>{item.plan?.map((step, index) => <li key={index}>{step.step} <span>{statusLabel(step.status)}</span></li>)}</ol>
          {snapshot.pendingPlan?.itemId === item.id && <div className="codex-app-server-plan-confirm" role="group" aria-label="确认执行计划">
            <p>{snapshot.provider === "codebuddy" ? "确认后将允许请求方执行此计划。" : "计划已完成。确认后将在当前会话中执行。"}</p>
            <div><button type="button" disabled={resolvingPlan} onClick={() => void resolvePlan(item.id, false)}>暂不执行</button>
              <button type="button" className="primary" disabled={resolvingPlan} onClick={() => void resolvePlan(item.id, true)}>执行计划</button></div>
          </div>}
          {openCodePlanItemId === item.id && openCodeBuildMode && <div className="codex-app-server-plan-confirm">
            <button type="button" className="primary" disabled={resolvingPlan || changingMode} onClick={() => void resolvePlan(item.id, true)}>执行计划</button>
          </div>}
        </article>;
        if (item.type === "questionAnswer") return <article className="codex-app-server-message question-answer" key={item.id} aria-label={`已回答的 ${agentName} 提问`}>
          <strong>{agentName} 提问与回答{item.status === "submitted" ? snapshot.provider === "codebuddy" ? " · 已发送" : " · 正在确认" : item.status === "failed" ? " · 轮次失败" : ""}</strong>
          {item.questions?.map(question => <div className="codex-app-server-answered-question" key={question.id}>
            {question.header && <small>{question.header}</small>}
            <p className="codex-app-server-answered-prompt">{question.question}</p>
            {question.answers.map((answer, index) => <p key={index} className="codex-app-server-answered-answer">
              {answer.startsWith("user_note: ") ? `补充说明：${answer.slice(11)}` : answer}
            </p>)}
          </div>)}
        </article>;
        if (item.type === "contextCompaction" && snapshot.provider === "opencode") return <CompactionCard key={item.id} item={item} className="codex-app-server-message context-compaction" />;
        if (item.type === "contextCompaction" && isCodex) return null;
        if (item.type === "contextCompaction") return <article className="codex-app-server-message context-compaction" key={item.id} role="status">
          {item.status === "failed" ? "上下文压缩失败" : item.status === "completed" ? "上下文压缩完成" : "正在压缩上下文…"}
        </article>;
        if (isCodex) return <CodexEventCard key={item.id} item={item} />;
        return null;
      })}
      {snapshot.compacting && <div className="codex-app-server-compaction-status" role="status">正在压缩当前会话，请等待完成…</div>}
      {snapshot.reviewing && <div className="codex-app-server-compaction-status" role="status">正在审查代码，可停止审查后继续发送消息。</div>}
      {!snapshot.compacting && snapshot.compactionStatus === "failed" && !snapshot.error &&
        <div className="codex-app-server-compaction-status" role="alert">{isCodex ? "上下文压缩失败，请重试。" : "上下文压缩失败，请查看会话记录。"}</div>}
      {snapshot.approvals.map(approval => <ApprovalCard key={approval.requestId} approval={approval} items={snapshot.items} isCodex={isCodex}
        onResolve={decision => window.codexAppServerApi.resolveApproval(sessionId, approval.requestId, decision)} />)}
      {snapshot.questions?.filter(question => !question.submitting || !snapshot.items.some(item => item.id === `question-answer:${question.params.turnId}:${question.requestId}`))
        .map(question => <QuestionCard key={question.requestId} sessionId={sessionId} request={question}
          provider={snapshot.provider === "codebuddy" ? "codebuddy" : snapshot.provider === "claude" ? "claude" : snapshot.provider === "opencode" ? "opencode" : "codex"} />)}
      {snapshot.elicitations?.map(request => <McpElicitationCard key={request.requestId} sessionId={sessionId} request={request} />)}
      {isOpenCode && <OpenCodeRetryStatus retry={snapshot.openCodeRetry} className="codex-app-server-compaction-status" />}
      {snapshot.permissionError && <div className="codex-app-server-error" role="alert"><span>{snapshot.permissionError}</span><button type="button" onClick={() => setConfigurationOpen(true)}>配置与权限</button></div>}
      {(error || (snapshot.error !== dismissedSnapshotError && snapshot.error)) &&
        <div className="codex-app-server-error" role="alert">
          <span>{error || snapshot.error}</span>
          <button type="button" aria-label="关闭错误提示" title="关闭错误提示" onClick={() => {
            setError("");
            setDismissedSnapshotError(snapshot.error);
          }}><X aria-hidden="true" /></button>
        </div>}
    </div>
    <form className="codex-app-server-composer" onSubmit={event => {
      event.preventDefault();
      if (slashQuery !== null) {
        const command = visibleSlashCommands[selectedSlashIndex];
        if (command && !command.disabled) executeSlashCommand(command);
      } else void submit();
    }}>
      {!imagesAllowed && <p role="status">{IMAGE_INPUT_UNSUPPORTED}</p>}
      {attachments.length > 0 && <div className="codex-app-server-attachments">{attachments.map(filePath => <AttachmentTile key={filePath} sessionId={sessionId}
        file={{ path: filePath, name: fileName(filePath) }} onPreview={() => setPreviewFile({ path: filePath, name: fileName(filePath) })}
        onRemove={() => void removeAttachment(filePath)} disabled={(snapshot.busy && !canSendWhileBusy) || sending || pastingImage} />)}</div>}
      {slashQuery !== null && <div id={slashListId} className="codex-app-server-slash-commands" role="listbox" aria-label="会话操作联想">
        <div className="codex-app-server-file-mentions-heading">会话操作</div>
        {visibleSlashCommands.length === 0 ? <div className="codex-app-server-file-mentions-empty">没有匹配的操作</div>
          : visibleSlashCommands.map((command, index) => <button key={command.id} type="button" role="option"
              id={`${slashListId}-option-${index}`} aria-label={`/${command.id} ${command.label}`} aria-selected={index === selectedSlashIndex} disabled={command.disabled}
              className={index === selectedSlashIndex ? "selected" : ""} onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => setSelectedSlashIndex(index)} onClick={() => executeSlashCommand(command)}>
              <span>/{command.id}</span><small>{command.label}</small>
            </button>)}
      </div>}
      {fileMention && slashQuery === null && <div className="codex-app-server-file-mentions">
        <div className="codex-app-server-file-mentions-heading">搜索工作区文件与文件夹{fileSearchStatus === "loading" ? " · 搜索中..." : ""}</div>
        <WorkspaceMentionFilter value={entryType} />
        <div id={fileListId} role="listbox" aria-label="搜索工作区文件与文件夹" className="workspace-mention-results">
          {fileSearchStatus === "error" ? <div className="codex-app-server-file-mentions-empty" role="alert">搜索失败：{fileSearchError}</div>
            : fileSearchStatus === "ready" && fileResults.length === 0 ? <div className="codex-app-server-file-mentions-empty">没有匹配的文件或文件夹</div>
            : fileResults.map((entry, index) => <button key={entry.path} ref={element => { fileResultRefs.current[index] = element; }}
                id={`${fileListId}-option-${index}`} title={entry.relativePath} type="button" role="option" aria-selected={index === selectedFileIndex}
                className={index === selectedFileIndex ? "selected" : ""} onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setSelectedFileIndex(index)} onClick={() => selectFile(entry)}>
                {entry.type === "directory" ? <Folder aria-hidden="true" /> : <FileIcon aria-hidden="true" />}<span>{entry.name}</span><small>{entry.relativePath}</small>
              </button>)}
        </div>
      </div>}
      <div className={`codex-app-server-input-border${snapshot.busy ? " is-running" : ""}`} data-mode={snapshot.mode}><textarea ref={textareaRef} value={draft} onChange={event => {
        const next = event.target.value;
        changeDraft(next);
        setSlashDismissed(false); setSelectedSlashIndex(0);
        setDraftReferences(current => current.filter(value => next.includes(value.token)));
        const mention = fileMentionAtCaret(next, event.target.selectionStart);
        if (mention) setFileMention(mention);
        else closeFileMention();
      }} onClick={event => {
        const mention = fileMentionAtCaret(draft, event.currentTarget.selectionStart);
        if (mention) setFileMention(mention);
        else closeFileMention();
      }} onCompositionEnd={event => {
        const mention = fileMentionAtCaret(event.currentTarget.value, event.currentTarget.selectionStart);
        if (mention) setFileMention(mention);
        else closeFileMention();
      }} onKeyUp={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const mention = fileMentionAtCaret(event.currentTarget.value, event.currentTarget.selectionStart);
        if (mention) setFileMention(mention);
        else closeFileMention();
      }} onPaste={event => {
        const files = Array.from(event.clipboardData.files || []).filter(file => file.type.startsWith("image/") || sendableImageFile(file.name));
        if (!files.length && !Array.from(event.clipboardData.items).some(item => item.type.startsWith("image/"))) return;
        event.preventDefault();
        void pasteImage(files);
      }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        const filter = fileMention && slashQuery === null ? workspaceMentionFilterKey(event) : null;
        if (filter) {
          event.preventDefault();
          event.stopPropagation();
          if (filter !== entryType) {
            fileSearchRequestRef.current += 1;
            setFileResults([]);
            setSelectedFileIndex(0);
            setFileSearchStatus("loading");
            setEntryType(filter);
          }
          return;
        }
        if (slashQuery !== null && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelectedSlashIndex(current => visibleSlashCommands.length ? (current + (event.key === "ArrowDown" ? 1 : -1) + visibleSlashCommands.length) % visibleSlashCommands.length : 0);
            return;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            const command = visibleSlashCommands[selectedSlashIndex];
            if (command && !command.disabled) executeSlashCommand(command);
            return;
          }
          if (event.key === "Escape") { event.preventDefault(); setSlashDismissed(true); return; }
        }
        if (fileMention && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelectedFileIndex(current => fileResults.length ? (current + (event.key === "ArrowDown" ? 1 : -1) + fileResults.length) % fileResults.length : 0);
            return;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            if (fileResults[selectedFileIndex]) selectFile(fileResults[selectedFileIndex]);
            return;
          }
          if (event.key === "Escape") { event.preventDefault(); closeFileMention(); return; }
        }
        if (event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent.isComposing) {
          if (snapshot.provider === "codebuddy") {
            event.preventDefault();
            const modes = snapshot.nativeModes || [];
            const inPlan = /plan/i.test(snapshot.nativeMode || "");
            const target = inPlan
              ? modes.find(mode => /^(bypasspermissions|fullaccess)$/i.test(normalizeModeKey(mode.id)))
              : modes.find(mode => /plan/i.test(mode.id));
            if (target && !snapshot.pendingPlan) void changeNativeMode(target.id);
            return;
          }
          if (snapshot.provider === "opencode") {
            const modes = snapshot.nativeModes || [];
            const build = modes.find(mode => normalizeModeKey(mode.id) === "build");
            const plan = modes.find(mode => normalizeModeKey(mode.id) === "plan");
            if (build && plan) {
              event.preventDefault();
              if (!snapshot.pendingPlan) void changeNativeMode(snapshot.nativeMode === plan.id ? build.id : plan.id);
            }
            return;
          }
          if (snapshot.provider !== "claude" && snapshot.provider !== "qoder" && snapshot.provider !== "gemini" && snapshot.provider !== "grok") {
            event.preventDefault();
            void changeMode(snapshot.mode === "plan" ? "default" : "plan");
          }
          return;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
      }} aria-label="图形对话输入" aria-autocomplete="list" aria-controls={slashQuery !== null ? slashListId : fileMention ? fileListId : undefined}
        aria-expanded={slashQuery !== null || Boolean(fileMention)} aria-activedescendant={slashQuery !== null && visibleSlashCommands[selectedSlashIndex] ? `${slashListId}-option-${selectedSlashIndex}` : fileMention && fileResults[selectedFileIndex] ? `${fileListId}-option-${selectedFileIndex}` : undefined}
        placeholder={snapshot.account?.status === "signedOut" ? "请先登录 Codex 账号" : snapshot.archived ? "此会话已归档，请先恢复归档" : `向 ${agentName} 发送消息`} disabled={!snapshot.threadId || snapshot.account?.status === "signedOut" || snapshot.archived || Boolean(forkingTurnId) || (snapshot.busy && !canSendWhileBusy && !canAskSideQuestion)} />
        <div className="codex-app-server-input-actions">
          <div className="codex-app-server-menu-anchor">
            <button ref={menuButtonRef} type="button" className="codex-app-server-icon-button" title="更多操作" aria-label="更多操作" aria-haspopup="menu" aria-expanded={menuOpen} disabled={(!snapshot.threadId && !isOpenCode && !isCodex) || Boolean(forkingTurnId)} onClick={() => { setCapabilityOpen(false); setMenuOpen(open => !open); }}><Ellipsis aria-hidden="true" /></button>
            {menuOpen && <GraphicalActionMenu key={snapshot.provider} menuRef={menuRef} onConfigure={() => { setMenuOpen(false); setMenuSettingsOpen(true); }} secondaryActions={graphicalMenuConfig[snapshot.provider || "codex"]}
              onClose={() => { setMenuOpen(false); menuButtonRef.current?.focus(); }}>
              {snapshot.provider === "codebuddy" && sessionType === "windows" && session && <button data-action="mcp-config" type="button" role="menuitem" onClick={() => { setMenuOpen(false); setCodeBuddyMcpOpen(true); }}>MCP 管理</button>}
              {isOpenCode && <button data-action="login" type="button" role="menuitem" disabled={snapshot.busy || sending || Boolean(snapshot.pendingPlan) || snapshot.approvals.length > 0 || Boolean(snapshot.questions?.length)} onClick={() => { setMenuOpen(false); setOpenCodeLoginOpen(true); }}>登录 OpenCode</button>}
              <button data-action="history" type="button" role="menuitem" disabled={!snapshot.threadId || snapshot.busy || snapshot.capabilities?.history === false} title={snapshot.capabilities?.history === false ? `当前 ${agentName} CLI 不支持历史会话恢复` : undefined} onClick={openHistory}><History aria-hidden="true" />历史会话</button>
              {isCodex && <>
                <button data-action="plugins" type="button" role="menuitem" onClick={() => { setMenuOpen(false); setPluginOpen(true); }}><Package aria-hidden="true" />插件管理</button>
                <button data-action="terminals" type="button" role="menuitem" disabled={!snapshot.threadId} onClick={() => { setMenuOpen(false); setBackgroundTerminalsOpen(true); }}><Terminal aria-hidden="true" />后台终端</button>
                <button data-action="compact" type="button" role="menuitem" disabled={snapshot.busy || sending} onClick={compactConversation}><Minimize2 aria-hidden="true" />压缩对话</button>
                <button data-action="review" type="button" role="menuitem" disabled={reviewDisabled} onClick={openReview}><FileIcon aria-hidden="true" />代码审查</button>
                <button data-action="goal" type="button" role="menuitem" onClick={openGoal}><Target aria-hidden="true" />目标管理</button>
              </>}
              {snapshot.provider === "opencode" && <button data-action="revert" type="button" role="menuitem"
                title={snapshot.historyActionsError || undefined}
                disabled={!snapshot.capabilities?.revertHistory || snapshot.busy || sending || rewindPending || Boolean(snapshot.pendingPlan || snapshot.approvals.length || snapshot.questions?.length) || !snapshot.items.some(item => item.type === "userMessage" && item.rewindMessageId)}
                onClick={() => { const target = [...snapshot.items].reverse().find(item => item.type === "userMessage" && item.rewindMessageId);
                  if (target?.rewindMessageId) { setRewindTarget({ messageId: target.rewindMessageId, text: target.text || "" }); setRewindError(""); setMenuOpen(false); }
                }}>撤销上一轮</button>}
              {snapshot.provider === "codebuddy" && <button data-action="goal" type="button" role="menuitem" onClick={openGoal}><Target aria-hidden="true" />目标管理</button>}
              {canManageCodeBuddyPlugins && <button data-action="plugins" type="button" role="menuitem" onClick={() => { setMenuOpen(false); setPluginOpen(true); }}><Package aria-hidden="true" />插件管理</button>}
              {canManageCodeBuddyPlugins && <button data-action="tasks" type="button" role="menuitem" onClick={() => { setMenuOpen(false); setScheduledTasksOpen(true); }}>定时任务</button>}
              {canManageCodeBuddyJobs && <button data-action="jobs" type="button" role="menuitem" onClick={() => { setMenuOpen(false); setCodeBuddyJobsOpen(true); }}>后台智能体</button>}
              {(!isAcp || Boolean(snapshot.nativeModes?.length)) && <button data-action="mode" type="button" role="menuitem" onClick={() => openSelection("mode")}>模式 <small>{isAcp ? snapshot.nativeModes?.find(mode => mode.id === snapshot.nativeMode)?.name || snapshot.nativeMode || "默认"
                : snapshot.mode === "plan" ? "Plan" : "Exec"}</small></button>}
              {mainAgent && <button data-action="main-agent" type="button" role="menuitem" disabled={mainAgentPending} onClick={() => openSelection("mainAgent")}>主 Agent <small>{mainAgentLabel}</small></button>}
              {multitaskOption && <button data-action="multitask" type="button" role="menuitem" onClick={() => openSelection("multitask")}>Multitask <small>{multitaskOption.currentValue === true ? "开启" : "关闭"}</small></button>}
              {(acpModel || codeBuddyUnifiedModel || codexUnifiedModel || (!isAcp && snapshot.backend === "openai")) && <button data-action="model" type="button" role="menuitem" onClick={() => openSelection("model")}>模型 <small>{codexUnifiedModel ? codexCurrentName : codeBuddyUnifiedModel ? codeBuddyCurrentName : acpModel ? acpModel.options?.find(option => option.value === acpModel.currentValue)?.name || acpModel.currentValue : currentModel?.displayName || "默认模型"}</small></button>}
              {snapshot.provider === "opencode" && sessionType !== "ssh" && onReconnectModels && <button data-action="reconnect-models" type="button" role="menuitem" disabled={snapshot.busy || sending} onClick={() => { setMenuOpen(false); void onReconnectModels(sessionId).catch(cause => setError(message(cause))); }}>重新连接以更新模型</button>}
              {acpContextWindow && <button data-action="context-window" type="button" role="menuitem" onClick={() => openSelection("contextWindow")}>上下文窗口 <small>{acpContextWindow.options?.find(option => option.value === acpContextWindow.currentValue)?.name || acpContextWindow.currentValue}</small></button>}
              {(acpEffort || (!isAcp && snapshot.backend === "openai" && Boolean(currentModel?.supportedReasoningEfforts?.length))) && <button data-action="effort" type="button" role="menuitem" onClick={() => openSelection("effort")}>思考强度 <small>{acpEffort ? acpEffort.options?.find(option => option.value === acpEffort.currentValue)?.name || acpEffort.currentValue : snapshot.effort ? effortLabel(snapshot.effort) : "默认"}</small></button>}
              {!isAcp && snapshot.backend === "openai" && <button data-action="fast-mode" type="button" role="menuitem" onClick={() => openSelection("fastMode")}>快速模式 <small>{snapshot.fastMode ? "开启" : "关闭"}</small></button>}
              {isCodex && sessionType === "windows" && snapshot.windowsSandboxSetup?.available && <button data-action="sandbox" type="button" role="menuitem" onClick={() => { setMenuOpen(false); setSandboxSetupOpen(true); }}>Windows 沙箱初始化</button>}
              {!isAcp && <><button data-action="permission" type="button" role="menuitem" onClick={() => openSelection("permission")}>执行权限 <small>{snapshot.permissionProfileId || permissionLabels[snapshot.executionPermission]}</small></button><button data-action="configuration" type="button" role="menuitem" onClick={() => { setMenuOpen(false); setConfigurationOpen(true); }}>配置与权限</button></>}
              {(isCodex || isOpenCode) && <button data-action="capabilities" type="button" role="menuitem" onClick={() => openCapabilities(isOpenCode && capabilityTab === "apps" ? "skills" : capabilityTab)}><BookOpen aria-hidden="true" />{isCodex ? "Skills、Apps 和 MCP" : "Skills 和 MCP"}</button>}
              <button data-action="attachments" type="button" role="menuitem" disabled={!canAttach} onClick={() => { setMenuOpen(false); textareaRef.current?.focus(); void addFiles(); }}><Paperclip aria-hidden="true" />附加文件</button>
            </GraphicalActionMenu>}
            {(isCodex || isOpenCode) && capabilityOpen && <div ref={capabilityRef} className="codex-app-server-capability-picker" role="dialog" aria-label="选择会话能力" onKeyDown={event => {
              if (event.key === "Escape") { event.preventDefault(); setCapabilityOpen(false); menuButtonRef.current?.focus(); }
            }}>
              <div className="codex-app-server-capability-tabs" role="tablist" aria-label="能力类型">
                {(isCodex ? ["skills", "apps", "mcp"] as const : ["skills", "mcp"] as const).map(tab => <button key={tab} type="button" role="tab" aria-selected={capabilityTab === tab}
                  onClick={() => { setCapabilityTab(tab); setCapabilityQuery(""); }}>{tab === "skills" ? "Skills" : tab === "apps" ? "Apps" : "MCP"}</button>)}
              </div>
              <div className="codex-app-server-capability-search"><input autoFocus type="search" value={capabilityQuery} onChange={event => setCapabilityQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} placeholder="搜索能力" aria-label="搜索能力" />
                <button type="button" aria-label="刷新能力" title="刷新能力" disabled={capabilityLoading || Boolean(skillPendingPath)} onClick={() => void loadCapabilities(true)}><RefreshCw aria-hidden="true" /></button></div>
              <div className="codex-app-server-capability-list">
                {capabilityLoading && <p>正在读取当前会话能力…</p>}
                {capabilityError && <p role="alert">{capabilityError}</p>}
                {capabilities?.errors[capabilityTab] && <p role="alert">{capabilities.errors[capabilityTab]}</p>}
                {isCodex && capabilityTab === "skills" && <p>启停设置保存到当前运行环境的 Codex 配置，并非仅影响当前会话。</p>}
                {!capabilityLoading && capabilityTab === "skills" && capabilities?.skills.filter(skill => matchesCapability(skill.name, skill.description)).map(skill =>
                  <div className="codex-capability-app-row" key={skill.path || skill.id || skill.name}><button type="button" disabled={!skill.enabled || Boolean(skillPendingPath)} onClick={() => isOpenCode
                    ? insertCapability(`请使用 skill 工具加载 ${skill.id || skill.name}`)
                    : insertCapability(`$${skill.name}`, { kind: "skill", name: skill.name, path: skill.path, token: `$${skill.name}` })}>
                    <BookOpen aria-hidden="true" /><span><strong>{skill.name}</strong><small>{skill.description || skill.scope}</small></span>{!skill.enabled && <em>已停用</em>}</button>
                    {isCodex && <button type="button" className="codex-capability-detail-button" aria-label={`${skill.enabled ? "禁用" : "启用"}技能 ${skill.name}`}
                      disabled={!snapshot.threadId || snapshot.busy || sending || Boolean(snapshot.archived || snapshot.compacting || snapshot.reviewing) || sandboxSettingUp || snapshot.account?.status === "signedOut" || Boolean(skillPendingPath)}
                      onClick={() => void toggleSkill(skill)}>{skillPendingPath === skill.path ? "保存中…" : skill.enabled ? "禁用" : "启用"}</button>}</div>)}
                {!capabilityLoading && capabilityTab === "apps" && capabilities?.apps.filter(app => matchesCapability(app.name, app.description)).map(app =>
                  <div className="codex-capability-app-row" key={app.id}><button type="button" disabled={!app.accessible || !app.enabled || !app.callable} onClick={() => insertCapability(`$${app.id}`, { kind: "app", name: app.name, path: `app://${app.id}`, token: `$${app.id}` })}>
                    <Globe2 aria-hidden="true" /><span><strong>{app.name}</strong><small>{app.description}</small></span>{(!app.accessible || !app.enabled || !app.callable) && <em>不可用</em>}</button>
                    {isCodex && <button type="button" className="codex-capability-detail-button" aria-label="查看 App 详情" title={`查看 ${app.name} 详情`} onClick={() => setCapabilityDetail({ kind: "app", id: app.id })}>详情</button>}</div>)}
                {!capabilityLoading && capabilityTab === "mcp" && capabilities?.mcp.filter(server => matchesCapability(server.name, server.tools.map(tool => `${tool.name} ${tool.description}`).join(" "))).map(server =>
                  <div className="codex-app-server-capability-server" key={server.name}><strong><Cable aria-hidden="true" />{server.name}<small>{server.status}</small>
                    {isCodex && <button type="button" className="codex-capability-detail-button" aria-label={`查看 ${server.name} 详情`} onClick={() => setCapabilityDetail({ kind: "mcp", server })}>详情</button>}</strong>
                    {server.toolsError && <p role="alert">{server.toolsError}</p>}
                    {server.tools.filter(tool => matchesCapability(server.name, `${tool.name} ${tool.description}`)).map(tool =>
                      <button key={tool.name} type="button" disabled={server.status !== "connected"} onClick={() => insertCapability(`请使用 MCP 工具 ${isOpenCode ? tool.name : `mcp__${server.name}__${tool.name}`}`)}>
                        <Wrench aria-hidden="true" /><span><strong>{tool.name}</strong><small>{tool.description}</small></span></button>)}
                  </div>)}
                {!capabilityLoading && capabilities && !capabilities.errors[capabilityTab] &&
                  ((capabilityTab === "skills" && !capabilities.skills.some(skill => matchesCapability(skill.name, skill.description)))
                    || (capabilityTab === "apps" && !capabilities.apps.some(app => matchesCapability(app.name, app.description)))
                    || (capabilityTab === "mcp" && !capabilities.mcp.some(server => matchesCapability(server.name, server.tools.map(tool => `${tool.name} ${tool.description}`).join(" "))))) && <p>没有匹配的能力。</p>}
              </div>
            </div>}
          </div>
          {(!isAcp || Boolean(snapshot.nativeModes?.length)) && <span className="codex-app-server-permission-status" data-permission={snapshot.executionPermission}>{isAcp
            ? `模式：${snapshot.nativeModes?.find(mode => mode.id === snapshot.nativeMode)?.name || snapshot.nativeMode || "默认"}`
            : `执行权限：${snapshot.permissionProfileId || permissionLabels[snapshot.executionPermission] || "需要确认"}`}</span>}
          {isCodex && snapshot.goal && <button type="button" className="codex-app-server-goal-chip"
            title={snapshot.goal.objective} onClick={() => setGoalOpen(true)}><Target aria-hidden="true" />{snapshot.goal.status === "active" ? "目标进行中" : snapshot.goal.status === "paused" ? "目标已暂停" : "目标已结束"}</button>}
          {snapshot.provider === "codebuddy" && snapshot.codeBuddyGoal?.active && <button type="button" className="codex-app-server-goal-chip"
            title={snapshot.codeBuddyGoal.active.condition} onClick={() => setGoalOpen(true)}><Target aria-hidden="true" />
            {snapshot.codeBuddyGoal.active.paused ? "目标已暂停" : "目标进行中"}</button>}
          {isCodex && snapshot.backend === "openai" && <span className="codex-app-server-permission-status">{(snapshot.models || []).find(model => model.id === snapshot.model)?.displayName || snapshot.model || "默认模型"}{snapshot.effort ? ` · ${effortLabel(snapshot.effort)}` : ""}{snapshot.fastMode ? " · 快速" : ""}</span>}
          {acpModel && <span className="codex-app-server-permission-status">{acpModel.options?.find(option => option.value === acpModel.currentValue)?.name || acpModel.currentValue || "默认模型"}{typeof acpModel.currentValue === "string" && modelDetails(acpModel.currentValue) ? ` · ${modelDetails(acpModel.currentValue)}` : ""}{acpEffort?.currentValue ? ` · ${acpEffort.options?.find(option => option.value === acpEffort.currentValue)?.name || acpEffort.currentValue}` : ""}{acpContextWindow?.currentValue ? ` · ${acpContextWindow.options?.find(option => option.value === acpContextWindow.currentValue)?.name || acpContextWindow.currentValue}` : ""}</span>}
          {!acpModel && acpContextWindow?.currentValue && <span className="codex-app-server-permission-status">上下文窗口：{acpContextWindow.options?.find(option => option.value === acpContextWindow.currentValue)?.name || acpContextWindow.currentValue}</span>}
          {mainAgent && <button type="button" className="codex-app-server-goal-chip" disabled={mainAgentPending} onClick={() => openSelection("mainAgent")} title={mainAgent.sessionBlank ? "选择主 Agent" : "新建对话后可切换主 Agent"}>主 Agent：{mainAgentLabel}{!mainAgent.sessionBlank && !mainAgent.error ? " · 已锁定" : ""}</button>}
          <span className="codex-app-server-shortcuts">Enter 发送 · Shift+Enter 换行{snapshot.provider === "codebuddy" ? " · Shift+Tab 切换 Plan / Full Access" : snapshot.provider === "opencode" ? " · Shift+Tab 切换 Build / Plan" : ""}</span>
          <div className="codex-app-server-input-primary">
            <button type="button" className="codex-app-server-icon-button" title="新对话" aria-label="新对话" disabled={Boolean(snapshot.permissionError || snapshot.changingPermission || changingPermission) || sandboxSettingUp || !snapshot.threadId || snapshot.busy || mainAgentPending || sending || pastingImage || Boolean(forkingTurnId)} onClick={startNewConversation}><Plus aria-hidden="true" /></button>
            {canAskSideQuestion && <button type="button" className="codebuddy-side-trigger" aria-label="旁问" title="独立旁问 /btw" disabled={!snapshot.threadId || mainAgentPending} onClick={() => openSideQuestion()}>旁问</button>}
            {snapshot.busy && <button type="button" className="codex-app-server-send" title="停止" aria-label="停止" onClick={() => void window.codexAppServerApi.interrupt(sessionId).catch(cause => setError(message(cause)))}><Square aria-hidden="true" /></button>}
            {(!snapshot.busy || canSendWhileBusy || Boolean(btwMatch)) && <button type="submit" className="codex-app-server-send" title="发送" aria-label="发送" disabled={Boolean(snapshot.permissionError || snapshot.changingPermission || changingPermission) || sandboxSettingUp || !snapshot.threadId || snapshot.account?.status === "signedOut" || snapshot.archived || mainAgentPending || sending || pastingImage || Boolean(forkingTurnId) || (!draft.trim() && attachments.length === 0)}><ArrowUp aria-hidden="true" /></button>}
          </div>
        </div>
      </div>
    </form>
      </div>
      {isCodex && snapshot.threadId && Boolean(snapshot.subAgents?.members.length) && snapshot.subAgents && <CodexSubAgentPanel
        sessionId={sessionId} threadId={snapshot.threadId} state={snapshot.subAgents} minimalMode={minimalMode} onLinkClick={onLinkClick} />}
      {snapshot.provider === "codebuddy" && snapshot.team && <aside className="codex-app-server-team-pane" aria-label="Agent Teams">
        <div className="codex-app-server-team-heading"><strong>Agent Teams</strong><span>{snapshot.team.name || "团队加载中"}{snapshot.team.isAutoTeam ? " · 自动团队" : ""}</span></div>
        <div className="codex-app-server-team-members" role="tablist" aria-label="团队成员">
          {snapshot.team.members.map(member => <button key={member.name} type="button" role="tab" aria-selected={selectedMember?.name === member.name}
            onClick={() => { if (member.name !== selectedMember?.name) setMemberDraft(""); setSelectedMemberName(member.name); setMemberError(""); }}>
            <span className="codex-app-server-team-dot" data-status={member.status} />
            <strong>{member.name}</strong><small>{teamStatusLabels[member.status] || member.status}</small>
          </button>)}
        </div>
        {selectedMember ? <>
          <div className="codex-app-server-team-member-detail"><strong>{selectedMember.name}</strong>
            <span>{teamStatusLabels[selectedMember.status] || selectedMember.status}</span>
            {selectedMember.description && <p>{selectedMember.description}</p>}
            {(selectedMember.tokenUsage || selectedMember.toolCallCount != null) && <small>
              {selectedMember.tokenUsage ? `输入 ${selectedMember.tokenUsage.inputTokens || 0} · 输出 ${selectedMember.tokenUsage.outputTokens || 0}` : ""}
              {selectedMember.toolCallCount != null ? ` · 工具 ${selectedMember.toolCallCount}` : ""}
            </small>}
          </div>
          <TeamMemberTimeline key={`${snapshot.threadId}:${snapshot.team.name}:${selectedMember.name}`} member={selectedMember} messageCopy minimalMode={minimalMode} onLinkClick={onLinkClick} />
          <form className="codex-app-server-team-composer" onSubmit={event => { event.preventDefault(); void sendMemberMessage(); }}>
            <label htmlFor="codebuddy-team-message">发给 {selectedMember.name}</label>
            <textarea id="codebuddy-team-message" value={memberDraft} onChange={event => setMemberDraft(event.target.value)}
              onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMemberMessage(); } }}
              disabled={sendingMember || selectedMember.status === "removed"} placeholder="给成员发送消息…" />
            {memberError && <p role="alert">{memberError}</p>}
            <button type="submit" disabled={!memberDraft.trim() || sendingMember || selectedMember.status === "removed"}>{sendingMember ? "发送中…" : "发送给成员"}</button>
          </form>
        </> : <p className="codex-app-server-team-empty">团队尚无成员。</p>}
      </aside>}
    </div>
    {menuSettingsOpen && <GraphicalMenuSettingsDialog initialProvider={snapshot.provider || "codex"} onClose={() => { setMenuSettingsOpen(false); menuButtonRef.current?.focus(); }} />}
    {selectionKind && <div className="modal-overlay codex-app-server-selection-overlay" onMouseDown={event => { if (event.target === event.currentTarget) closeSelection(); }}>
      <div ref={selectionDialogRef} className="modal-dialog codex-app-server-selection-dialog" role="dialog" aria-modal="true"
        aria-labelledby="codex-app-server-selection-title" onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSelection(); return; }
          if (event.key !== "Tab") return;
          const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
        }}>
        <div className="codex-app-server-selection-header"><h2 id="codex-app-server-selection-title">{selectionTitles[selectionKind]}</h2>
          <button type="button" aria-label={`关闭${selectionTitles[selectionKind]}`} disabled={selectionPending} onClick={closeSelection}><X aria-hidden="true" /></button></div>
        {selectionKind === "mainAgent" && <>
          <p className="codex-app-server-selection-hint">{mainAgentLoading ? "正在读取主 Agent…" : mainAgent?.sessionBlank ? "仅空白会话可切换，CLI 会记住上次选择。" : "新建对话后可切换主 Agent。"}</p>
          {mainAgent?.error && <p role="alert">{mainAgent.error}</p>}
          <button type="button" disabled={mainAgentLoading || selectionPending} onClick={() => void loadMainAgents()}>刷新主 Agent</button>
        </>}
        {selectionNextTurn && <p className="codex-app-server-selection-hint">下一轮生效{selectionKind === "fastMode" ? " · 开启后用量成本更高" : ""}</p>}
        <div className="codex-app-server-selection-options" role="radiogroup" aria-label={selectionTitles[selectionKind]}>
          {selectionOptions.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.selected}
            disabled={selectionPending || option.disabled} onClick={() => void selectOption(option.value)}>
            <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
            {option.selected && <Check aria-hidden="true" />}
          </button>)}
          {selectionOptions.length === 0 && <p>当前会话没有可选项。</p>}
        </div>
        {selectionError && <p className="codex-app-server-selection-error" role="alert">{selectionError}</p>}
        {selectionKind === "model" && codeBuddyModelLoadError && <p className="codex-app-server-selection-error" role="alert">{codeBuddyModelLoadError}</p>}
        {selectionKind === "model" && codexModelLoadError && <p className="codex-app-server-selection-error" role="alert">{codexModelLoadError}</p>}
        {selectionKind === "model" && openCodeModelLoadError && <p className="codex-app-server-selection-error" role="alert">{openCodeModelLoadError}</p>}
        <div className="codex-app-server-selection-actions"><button type="button" disabled={selectionPending} onClick={closeSelection}>取消</button></div>
      </div>
    </div>}
    {reviewOpen && isCodex && <CodexReviewDialog key={`${sessionId}:${snapshot.threadId}`} sessionId={sessionId}
      disabled={reviewDisabled} onClose={() => setReviewOpen(false)} />}
    {scheduledTasksOpen && canManageCodeBuddyPlugins && snapshot.threadId && <CodeBuddyScheduledTasksDialog key={`${sessionId}:${snapshot.threadId}`} sessionId={sessionId} threadId={snapshot.threadId} onClose={() => setScheduledTasksOpen(false)} />}
    {sideQuestionOpen && canAskSideQuestion && <CodeBuddySideQuestionDialog key={`${sessionId}:${snapshot.threadId}`}
      sessionId={sessionId} snapshot={snapshot} initialQuestion={sideQuestionInitial} onClose={() => setSideQuestionOpen(false)}
      onUpdated={updateSideQuestion} />}
    {goalOpen && isCodex && <CodexGoalDialog
      key={`${sessionId}:${snapshot.threadId}`} sessionId={sessionId} snapshot={snapshot} onClose={() => setGoalOpen(false)}
      onUpdated={value => { if (currentSessionRef.current === sessionId && value.threadId === snapshot.threadId) setSnapshot(value); }} />}
    {goalOpen && snapshot.provider === "codebuddy" && <CodeBuddyGoalDialog
      key={`${sessionId}:${snapshot.threadId}`} sessionId={sessionId} snapshot={snapshot} onClose={() => { setGoalOpen(false); menuButtonRef.current?.focus(); }}
      onUpdated={value => { if (currentSessionRef.current === sessionId && value.threadId === snapshot.threadId) setSnapshot(value); }} />}
    {pluginOpen && isCodex && <CodexPluginDialog key={sessionId} sessionId={sessionId} session={session} onClose={() => { setPluginOpen(false); menuButtonRef.current?.focus(); }}
      onChanged={() => { setCapabilities(null); }} />}
    {codeBuddyMcpOpen && session && snapshot.provider === "codebuddy" && <CodeBuddyMcpDialog key={`${sessionId}:${snapshot.threadId}`} session={session} snapshot={snapshot}
      onClose={() => setCodeBuddyMcpOpen(false)} onRestart={async () => {
        const next = await window.codeBuddyMcpApi.restart(sessionId);
        if (currentSessionRef.current === sessionId) { timelineRef.current = next; setSnapshot(next); }
      }} />}
    {pluginOpen && canManageCodeBuddyPlugins && <CodeBuddyPluginDialog key={sessionId} sessionId={sessionId} onClose={() => setPluginOpen(false)} />}
    {capabilityDetail && isCodex && <CodexCapabilityDetail key={`${sessionId}:${snapshot.threadId}:${capabilityDetail.kind}:${capabilityDetail.kind === "app" ? capabilityDetail.id : capabilityDetail.kind === "mcp" ? capabilityDetail.server.name : capabilityDetail.name}`}
      sessionId={sessionId} target={capabilityDetail} onClose={() => setCapabilityDetail(null)} />}
    {configurationOpen && isCodex && <div className="modal-overlay codex-app-server-history-overlay" onClick={() => setConfigurationOpen(false)}>
      <div className="modal-dialog codex-app-server-history-dialog codex-configuration-dialog" role="dialog" aria-modal="true" aria-label="配置与权限" onKeyDown={event => {
          if (event.key === "Escape") { event.stopPropagation(); setConfigurationOpen(false); menuButtonRef.current?.focus(); return; }
          if (event.key !== "Tab") return;
          const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), summary, [tabindex="0"]')];
          if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
        }} onClick={event => event.stopPropagation()}>
        <div className="codex-app-server-history-header"><strong>配置与权限</strong><button type="button" autoFocus aria-label="关闭配置与权限" onClick={() => setConfigurationOpen(false)}><X /></button></div>
        <CodexConfigurationPanel sessionKey={`${sessionId}:${snapshot.threadId || ""}`} locked={snapshot.account?.status === "signedOut" || snapshot.busy || sending || Boolean(snapshot.changingPermission || snapshot.archived || snapshot.compacting || snapshot.reviewing || snapshot.pendingPlan || snapshot.approvals.length || snapshot.questions?.length || snapshot.elicitations?.length || sandboxSettingUp)}
          read={() => window.codexAppServerApi.readConfiguration(sessionId)}
          selectProfile={async profileId => {
            const expectedThread = snapshot.threadId; const expectedSession = sessionId;
            changingPermissionRef.current = true; setChangingPermission(true);
            try { const result = await window.codexAppServerApi.setPermissionProfile(sessionId, profileId);
              if (currentSessionRef.current === expectedSession && timelineRef.current?.threadId === expectedThread) setSnapshot(result);
              return result;
            } finally { if (currentSessionRef.current === expectedSession) { changingPermissionRef.current = false; setChangingPermission(false); } }
          }}
          selectLegacy={async permission => {
            const expectedSession = sessionId; changingPermissionRef.current = true; setChangingPermission(true);
            try { const result = await window.codexAppServerApi.setExecutionPermission(sessionId, permission);
              if (currentSessionRef.current === expectedSession) setSnapshot(result); return result;
            } finally { if (currentSessionRef.current === expectedSession) { changingPermissionRef.current = false; setChangingPermission(false); } }
          }} />
      </div>
    </div>}
    {sandboxSetupOpen && isCodex && sessionType === "windows" && snapshot.windowsSandboxSetup?.available && <CodexWindowsSandboxDialog
      key={sessionId} sessionId={sessionId} setup={snapshot.windowsSandboxSetup} disabled={snapshot.busy || sending || pastingImage}
      onClose={() => setSandboxSetupOpen(false)} />}
    {backgroundTerminalsOpen && isCodex && snapshot.threadId && <CodexBackgroundTerminalsDialog key={`${sessionId}:${snapshot.threadId}`}
      sessionId={sessionId} onClose={() => setBackgroundTerminalsOpen(false)} />}
    {codeBuddyJobsOpen && canManageCodeBuddyJobs && snapshot.threadId && <CodeBuddyJobsDialog key={sessionId}
      sessionId={sessionId} cwd={session?.cwd || ""} snapshot={snapshot} onClose={() => setCodeBuddyJobsOpen(false)} />}
    {historyOpen && <div className="modal-overlay codex-app-server-history-overlay" onMouseDown={event => { if (event.target === event.currentTarget) closeHistory(); }}>
      <div className="modal-dialog codex-app-server-history-dialog" role="dialog" aria-modal="true" aria-labelledby="codex-app-server-history-title" onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); closeHistory(); return; }
        if (event.key !== "Tab") return;
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
        if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
      }}>
        <div className="codex-app-server-history-header"><h2 id="codex-app-server-history-title">历史会话</h2>
          <button type="button" aria-label="关闭历史会话" onClick={closeHistory}><X aria-hidden="true" /></button></div>
        {isCodex && <div className="codex-app-server-history-tabs" role="tablist" aria-label="会话状态">
          <button type="button" role="tab" aria-selected={!historyArchived} onClick={() => setHistoryArchived(false)}>进行中</button>
          <button type="button" role="tab" aria-selected={historyArchived} onClick={() => setHistoryArchived(true)}>已归档</button>
        </div>}
        <div className="codex-app-server-history-search"><input autoFocus type="search" aria-label="搜索历史会话" placeholder="搜索标题或会话 ID" value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} /></div>
        {copyNotice && <p className="codex-app-server-history-copy-notice" role="status">{copyNotice}</p>}
        <div className="codex-app-server-history" aria-label="历史会话列表">
          {visibleHistory.map(thread => <div className="codex-app-server-history-row" key={thread.id}>
            {renamingThreadId === thread.id ? <form className="codex-app-server-history-rename" onSubmit={event => { event.preventDefault(); if (renameDraft.trim()) void mutateHistory(thread.id, "rename", renameDraft); }}>
              <input autoFocus aria-label={`重命名 ${thread.title}`} value={renameDraft} onChange={event => setRenameDraft(event.target.value)} />
              <button type="submit" disabled={!renameDraft.trim() || Boolean(historyMutation)}>保存</button>
              <button type="button" onClick={() => setRenamingThreadId(null)}>取消</button>
            </form> : <button type="button" className="codex-app-server-history-select" disabled={snapshot.busy || mainAgentPending || sending || pastingImage || resumingHistory || Boolean(historyMutation) || Boolean(thread.archived) || thread.id === snapshot.threadId} onClick={() => void selectHistory(thread.id)}>
              <strong>{thread.isPinned && <Pin aria-hidden="true" />}{thread.title}</strong><small>会话 ID：{thread.id}</small><span>{new Date(thread.updatedAt * 1000).toLocaleString()} · {thread.source}</span>
            </button>}
            <div className="codex-app-server-history-actions">
              <button type="button" aria-label={`复制会话 ID：${thread.id}`} onClick={() => void copyText(thread.id, "会话 ID")}>复制 ID</button>
              {isCodex && <button type="button" disabled={Boolean(historyCopyingThreadId)} aria-label={`复制首条用户输入：${thread.id}`}
                onClick={() => void copyInitialUserInput(thread.id)}>{historyCopyingThreadId === thread.id ? "读取中…" : "复制首条输入"}</button>}
              {(isCodex || snapshot.provider === "codebuddy" || snapshot.capabilities?.renameHistory) && <button type="button" disabled={Boolean(historyMutation) || (snapshot.provider === "opencode" && (snapshot.busy || sending || resumingHistory || Boolean(snapshot.pendingPlan || snapshot.approvals.length || snapshot.questions?.length)))} onClick={() => { setRenamingThreadId(thread.id); setRenameDraft(thread.title); }}>重命名</button>}
              {snapshot.provider === "opencode" && <>
                {snapshot.capabilities?.forkHistory && <button type="button"
                  disabled={snapshot.busy || mainAgentPending || sending || pastingImage || resumingHistory || Boolean(historyMutation || snapshot.pendingPlan || snapshot.approvals.length || snapshot.questions?.length)}
                  onClick={() => void mutateHistory(thread.id, "fork")}>分叉</button>}
                {snapshot.capabilities?.deleteHistory && <button type="button"
                  title={thread.id === snapshot.threadId ? "请先切换到其他对话再删除" : undefined}
                  disabled={thread.id === snapshot.threadId || snapshot.busy || mainAgentPending || sending || pastingImage || resumingHistory || Boolean(historyMutation || snapshot.pendingPlan || snapshot.approvals.length || snapshot.questions?.length)}
                  onClick={() => void mutateHistory(thread.id, "delete")}>删除</button>}
                {historyMutation === thread.id && <span role="status">正在处理…</span>}
              </>}
              {isCodex && <>
              <button type="button" disabled={Boolean(historyMutation)} onClick={() => void mutateHistory(thread.id, "pin", !thread.isPinned)}>{thread.isPinned ? "取消置顶" : "置顶"}</button>
              {thread.archived ? <button type="button" disabled={Boolean(historyMutation)} onClick={() => void mutateHistory(thread.id, "unarchive")}>恢复归档</button> : <>
                <button type="button" disabled={snapshot.busy || Boolean(historyMutation)} onClick={() => void mutateHistory(thread.id, "fork")}>分叉</button>
                <button type="button" disabled={thread.id === snapshot.threadId && snapshot.busy || Boolean(historyMutation)} onClick={() => void mutateHistory(thread.id, "archive")}>归档</button>
              </>}
              </>}
            </div>
          </div>)}
          {visibleHistory.length === 0 && !loadingHistory && !historyError && <p>{normalizedHistoryQuery ? "没有匹配的历史会话。" : historyArchived ? "当前项目没有已归档会话。" : "当前项目没有历史会话。"}</p>}
          {historyError && <p className="codex-app-server-history-error" role="alert">{historyError}</p>}
          {historyError && <div className="codex-app-server-history-actions"><button type="button" onClick={() => void loadHistory(null, historyQuery)}>重试加载</button></div>}
          {loadingHistory && <p role="status">{historySlow ? "检索较慢，仍在读取历史会话…" : "正在加载历史会话…"}</p>}
          {!normalizedHistoryQuery && historyCursor && <button type="button" disabled={loadingHistory} onClick={() => void loadHistory(historyCursor)}>加载更多</button>}
        </div>
      </div>
    </div>}
    {isOpenCode && openCodeLoginOpen && <OpenCodeAuthDialog sessionId={sessionId} auth={snapshot.acpAuth} onClose={() => setOpenCodeLoginOpen(false)} />}
    {snapshot.provider === "opencode" && snapshot.openCodeRevert && <div className="codex-app-server-history-copy-notice" role="status">
      已回退，发送新消息将确认回退。
      <button type="button" disabled={!snapshot.capabilities?.revertHistory || snapshot.busy || sending || rewindPending || Boolean(snapshot.pendingPlan || snapshot.approvals.length || snapshot.questions?.length)} onClick={() => void restoreOpenCodeRevert()}>恢复已撤销内容</button>
      {revertedInput && <button type="button" disabled={snapshot.busy || sending} onClick={() => { setDraft(revertedInput); setDraftReferences([]); }}>取回原输入</button>}
    </div>}
    {rewindTarget && <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !rewindPending) setRewindTarget(null); }}>
      <div className="modal-dialog" role="dialog" aria-modal="true" aria-label={`${agentName} 会话回退`} onKeyDown={event => { if (event.key === "Escape" && !rewindPending) setRewindTarget(null); }}>
        <h2>回退到此处</h2><p>{rewindTarget.text.slice(0, 160) || "所选用户消息"}</p>
        {snapshot.provider === "opencode" ? <p>将回退此消息及后续对话和文件修改。回退后可恢复；发送新消息将确认回退。</p> : <fieldset disabled={rewindPending}><legend>回退范围</legend>
          {([ ["Conversation", "仅对话"], ["Code", "仅代码"], ["CodeAndConversation", "对话和代码"] ] as const).map(([value, label]) =>
            <label key={value}><input type="radio" name="codebuddy-rewind-scope" checked={rewindScope === value} onChange={() => setRewindScope(value)} />{label}</label>)}
        </fieldset>}
        {snapshot.provider === "codebuddy" && <p>代码回退只覆盖 CodeBuddy 文件编辑工具记录的改动；终端命令和外部修改不在其中。</p>}
        {rewindError && <p role="alert">{rewindError}</p>}
        <div><button type="button" disabled={rewindPending} onClick={() => setRewindTarget(null)}>取消</button>
          <button type="button" disabled={rewindPending || snapshot.busy} onClick={() => void confirmRewind()}>{rewindPending ? "正在回退…" : "确认回退"}</button></div>
      </div>
    </div>}
    {previewFile && <div className="modal-overlay codex-app-server-preview-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setPreviewFile(null); }}>
      <div className="modal-dialog codex-app-server-preview-dialog" role="dialog" aria-modal="true" aria-label={`预览 ${previewFile.name}`} onKeyDown={event => { if (event.key === "Escape") setPreviewFile(null); }}>
        <div className="codex-app-server-preview-header"><strong>{previewFile.name}</strong><button type="button" aria-label="关闭预览" onClick={() => setPreviewFile(null)}><X aria-hidden="true" /></button></div>
        <div className="codex-app-server-preview-content">
          {previewError ? <p role="alert">无法预览：{previewError}</p> : !preview ? <p>正在加载预览…</p>
            : preview.kind === "image" ? <img src={preview.dataUrl} alt={previewFile.name} />
            : preview.kind === "text" ? <pre>{preview.text}</pre>
            : preview.kind === "too_large" ? <p>文件过大，无法预览（上限 {Math.round(preview.limit / 1024 / 1024)} MB）。</p>
            : <p>此文件格式暂不支持预览。</p>}
        </div>
      </div>
    </div>}
  </section></CodeBuddyMcpAppContext.Provider>;
});
