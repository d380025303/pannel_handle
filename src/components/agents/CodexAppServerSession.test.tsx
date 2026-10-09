// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, useState } from "react";
import type { Ref } from "react";
import type { CodexCapabilityReference, TerminalSession } from "../../vite-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerSession as SessionView, type CodexAppServerSessionHandle } from "./CodexAppServerSession";
import { GraphicalSessionPanel } from "./GraphicalSessionPanel";

function CodexAppServerSession({ sessionId, ref, minimalMode = false }: { sessionId: string | null; ref?: Ref<CodexAppServerSessionHandle>; minimalMode?: boolean }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [references, setReferences] = useState<Record<string, CodexCapabilityReference[]>>({});
  if (!sessionId) return null;
  return <SessionView ref={ref} sessionId={sessionId} minimalMode={minimalMode} draft={drafts[sessionId] ?? ""} draftReferences={references[sessionId] ?? []}
    setDraftReferences={value => setReferences(current => ({ ...current,
      [sessionId]: typeof value === "function" ? value(current[sessionId] ?? []) : value }))} setDraft={value => setDrafts(current => {
    const nextDraft = typeof value === "function" ? value(current[sessionId] ?? "") : value;
    return { ...current, [sessionId]: nextDraft };
  })} />;
}

describe("CodexAppServerSession", () => {
  afterEach(cleanup);
  let changed: (payload: any) => void;
  const submit = vi.fn().mockResolvedValue(undefined);
  const resolveApproval = vi.fn().mockResolvedValue(undefined);
  const answerQuestion = vi.fn().mockResolvedValue(undefined);
  const cancelQuestion = vi.fn().mockResolvedValue(undefined);
  const resolveElicitation = vi.fn().mockResolvedValue(undefined);
  const openExternal = vi.fn().mockResolvedValue(undefined);
  const listHistory = vi.fn().mockResolvedValue({ data: [], nextCursor: null });
  const renameThread = vi.fn().mockResolvedValue(undefined);
  const rewind = vi.fn();
  const revertThread = vi.fn();
  const restoreThread = vi.fn();
  const pinThread = vi.fn().mockImplementation(async (_id, _threadId, isPinned) => ({ isPinned }));
  const forkTurnToNewSession = vi.fn().mockResolvedValue({ id: "run-2" });
  const forkThread = vi.fn().mockResolvedValue({ threadId: "branch-1", mode: "default", busy: false, error: null, items: [], approvals: [] });
  const archiveThread = vi.fn().mockResolvedValue(undefined);
  const unarchiveThread = vi.fn().mockResolvedValue(undefined);
  const setSkillEnabled = vi.fn();
  const listCapabilities = vi.fn().mockResolvedValue({ skills: [{ name: "review", path: "C:/skills/review/SKILL.md", description: "Review", enabled: true, scope: "user" }],
    apps: [{ id: "github", name: "GitHub", description: "Code", accessible: true, enabled: true, callable: true }],
    mcp: [{ name: "files", status: "connected", authStatus: "unsupported", toolsError: null,
      tools: [{ name: "read_file", description: "Read" }] }], errors: {} });
  const newThread = vi.fn().mockResolvedValue({ threadId: "thread-2", mode: "default", busy: false, error: null, items: [], approvals: [] });
  const compactThread = vi.fn().mockResolvedValue({ threadId: "thread-1", mode: "default", executionPermission: "askApproval",
    busy: true, compacting: true, compactionStatus: "running", error: null, items: [], approvals: [] });
  const listBackgroundTerminals = vi.fn().mockResolvedValue([]);
  const terminateBackgroundTerminal = vi.fn().mockResolvedValue({ terminated: true });
  const cleanBackgroundTerminals = vi.fn().mockResolvedValue(undefined);
  const getGoal = vi.fn().mockResolvedValue(undefined);
  const setGoal = vi.fn();
  const clearGoal = vi.fn();
  const resume = vi.fn().mockResolvedValue({ threadId: "old-thread", mode: "default", busy: false, error: null, items: [], approvals: [] });
  const setMode = vi.fn().mockImplementation(async (_id, mode) => ({ threadId: "thread-1", mode, busy: false, error: null, items: [], approvals: [] }));
  const setNativeMode = vi.fn().mockImplementation(async (_id, modeId) => ({ threadId: "thread-1", provider: "codebuddy", nativeMode: modeId,
    nativeModes: [{ id: "default", name: "Standard" }, { id: "plan", name: "Plan" }, { id: "bypassPermissions", name: "Full Access" }], mode: modeId === "plan" ? "plan" : "default",
    executionPermission: modeId === "bypassPermissions" ? "fullAccess" : "askApproval", busy: false, error: null, items: [], approvals: [] }));
  const setModel = vi.fn();
  const listModelMetadata = vi.fn().mockResolvedValue([]);
  const setContextWindow = vi.fn();
  const setEffort = vi.fn();
  const setMultitask = vi.fn();
  const sendTeamMessage = vi.fn().mockResolvedValue(undefined);
  const setFastMode = vi.fn();
  const setExecutionPermission = vi.fn().mockImplementation(async (_id, executionPermission) => ({
    threadId: "thread-1", mode: "default", executionPermission, busy: false, error: null, items: [], approvals: [] }));
  const chooseFiles = vi.fn().mockResolvedValue([]);
  const searchWorkspaceEntries = vi.fn().mockResolvedValue({ root: "C:\\work", results: [] });
  const pasteImage = vi.fn().mockResolvedValue({ status: "saved", path: "C:\\project\\.pannel-handle-images\\capture.png", size: 3 });
  const discardImage = vi.fn().mockResolvedValue(undefined);
  const executePlan = vi.fn().mockResolvedValue(undefined);
  const dismissPlan = vi.fn().mockImplementation(async () => ({ threadId: "thread-1", mode: "plan", busy: false,
    error: null, pendingPlan: null, items: [{ id: "plan-1", type: "plan", text: "# 正式计划" }], approvals: [] }));
  const writeText = vi.fn().mockResolvedValue(true);
  const readInitialUserInput = vi.fn().mockResolvedValue(null);

  beforeEach(() => {
    Object.defineProperty(window, "terminalApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ graphicalMenuSecondaryActions: {} }),
      onGraphicalMenuConfigChanged: () => () => {}
    } });
    setSkillEnabled.mockReset().mockResolvedValue(undefined);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    submit.mockClear(); resolveApproval.mockClear(); answerQuestion.mockReset().mockResolvedValue(undefined); cancelQuestion.mockReset().mockResolvedValue(undefined); resolveElicitation.mockReset().mockResolvedValue(undefined); openExternal.mockReset().mockResolvedValue(undefined); listHistory.mockReset().mockResolvedValue({ data: [], nextCursor: null }); renameThread.mockClear(); rewind.mockReset(); pinThread.mockReset().mockImplementation(async (_id, _threadId, isPinned) => ({ isPinned })); forkTurnToNewSession.mockReset().mockResolvedValue({ id: "run-2" }); forkThread.mockClear(); archiveThread.mockClear(); listCapabilities.mockClear(); newThread.mockClear(); compactThread.mockClear(); getGoal.mockClear(); setGoal.mockReset(); clearGoal.mockReset(); resume.mockClear(); setMode.mockClear(); setNativeMode.mockClear(); setModel.mockReset(); listModelMetadata.mockReset().mockResolvedValue([]); setContextWindow.mockReset(); setEffort.mockReset(); setMultitask.mockReset(); sendTeamMessage.mockReset().mockResolvedValue(undefined); setFastMode.mockReset(); setExecutionPermission.mockClear(); chooseFiles.mockClear(); searchWorkspaceEntries.mockReset().mockResolvedValue({ root: "C:\\work", results: [] }); pasteImage.mockClear(); discardImage.mockClear(); executePlan.mockClear(); dismissPlan.mockClear();
    revertThread.mockReset(); restoreThread.mockReset();
    listBackgroundTerminals.mockReset().mockResolvedValue([]);
    terminateBackgroundTerminal.mockReset().mockResolvedValue({ terminated: true });
    cleanBackgroundTerminals.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(window, "externalLinkApi", { configurable: true, value: { open: openExternal } });
    writeText.mockReset().mockResolvedValue(true);
    readInitialUserInput.mockReset().mockResolvedValue(null);
    Object.defineProperty(window, "clipboardApi", { configurable: true, value: { writeText } });
    Object.defineProperty(window, "projectSearchApi", { configurable: true, value: { searchWorkspaceEntries } });
    Object.defineProperty(window, "codexVersionApi", { configurable: true, value: {
      check: vi.fn().mockResolvedValue({ status: "current", currentVersion: "1.0.0", latestVersion: "1.0.0", restartRequired: false }),
      update: vi.fn()
    } });
    Object.defineProperty(window, "codeBuddyVersionApi", { configurable: true, value: {
      check: vi.fn().mockResolvedValue({ status: "current", currentVersion: "2.157.0", latestVersion: "2.157.0", restartRequired: false }),
      update: vi.fn()
    } });
    Object.defineProperty(window, "openCodeVersionApi", { configurable: true, value: {
      check: vi.fn().mockResolvedValue({ status: "current", currentVersion: "2.0.18", latestVersion: "2.0.18", restartRequired: false }),
      update: vi.fn()
    } });
    Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: {
      snapshot: vi.fn().mockResolvedValue({ threadId: "thread-1", mode: "default", executionPermission: "askApproval", busy: false, error: null, items: [], approvals: [] }),
      revertThread, restoreThread, submit, interrupt: vi.fn(), resolveApproval, answerQuestion, cancelQuestion, resolveElicitation, listHistory, readInitialUserInput, renameThread, rewind, pinThread, forkTurnToNewSession, forkThread, archiveThread, unarchiveThread, listCapabilities, setSkillEnabled,
      resume, newThread, compactThread, listBackgroundTerminals, terminateBackgroundTerminal, cleanBackgroundTerminals, getGoal, setGoal, clearGoal, setMode, setNativeMode, setModel, listModelMetadata, setContextWindow, setEffort, setMultitask, sendTeamMessage, setFastMode, setExecutionPermission, chooseFiles, pasteImage, discardImage, executePlan, dismissPlan,
      readAccount: vi.fn().mockResolvedValue({ status: "signedOut" }),
      previewAttachment: vi.fn().mockResolvedValue({ kind: "image", dataUrl: "data:image/png;base64,AA==" }),
      onChanged: (callback: typeof changed) => { changed = callback; return () => {}; },
      onDelta: () => () => {}
    } });
  });


  it("opens menu settings for the current Agent and restores focus when closed", async () => {
    window.codexAppServerApi.snapshot = vi.fn().mockResolvedValue({ threadId: "cb-1", provider: "codebuddy", mode: "default", executionPermission: "askApproval", busy: false, error: null, items: [], approvals: [] });
    render(<CodexAppServerSession sessionId="run-1" />);
    const more = screen.getByRole("button", { name: "更多操作" });
    await waitFor(() => expect(more).toHaveProperty("disabled", false));
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "更多菜单隐藏配置" }));
    const dialog = screen.getByRole("dialog", { name: "更多菜单隐藏配置" });
    expect(screen.getByRole("combobox", { name: "配置 Agent" })).toHaveProperty("value", "codebuddy");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "更多菜单隐藏配置" })).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("shares per-provider menu layout, applies live changes, and keeps nested action handlers", async () => {
    let configChanged: (config: Record<string, string[]>) => void = () => {};
    Object.defineProperty(window, "terminalApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ graphicalMenuSecondaryActions: { codex: ["history", "compact"] } }),
      onGraphicalMenuConfigChanged: (callback: typeof configChanged) => { configChanged = callback; return () => {}; }
    } });
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.queryByRole("menuitem", { name: "压缩对话" })).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: "其他操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "压缩对话" }));
    await waitFor(() => expect(compactThread).toHaveBeenCalledWith("run-1"));
    act(() => configChanged({ codex: [] }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.queryByRole("menuitem", { name: "其他操作" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "历史会话" })).toBeTruthy();
  });

  it("blocks image paste and keeps ordinary attachments on a text-only model", async () => {
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({ threadId: "thread-1", mode: "default", busy: false,
      error: null, executionPermission: "askApproval", pendingPlan: null, items: [], approvals: [], model: "text-only", models: [{ id: "text-only", displayName: "Text",
        fastAvailable: false, defaultReasoningEffort: null, supportedReasoningEfforts: [], inputModalities: ["text"] }] });
    chooseFiles.mockResolvedValueOnce(["C:\\project\\photo.bmp", "C:\\project\\notes.txt"]);
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息");
    await screen.findByText("当前模型不支持图片输入");
    fireEvent.change(input, { target: { value: "保留草稿" } });
    fireEvent.paste(input, { clipboardData: { items: [{ type: "image/png" }] } });
    expect(pasteImage).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe("保留草稿");
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "附加文件" }));
    await screen.findByText("notes.txt");
    expect(screen.queryByText("photo.bmp")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "保留草稿", ["C:\\project\\notes.txt"], []));
  });

  it("preserves desktop draft images when the model stops supporting them", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "保留草稿" } });
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.paste(input, { clipboardData: { items: [{ type: "image/png" }] } });
    await screen.findByText("capture.png");
    const draft = input.value;
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", executionPermission: "askApproval",
      pendingPlan: null, busy: false, error: null, items: [], approvals: [], model: "text-only",
      models: [{ id: "text-only", displayName: "Text", fastAvailable: false, defaultReasoningEffort: null,
        supportedReasoningEfforts: [], inputModalities: ["text"] }] } }));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(submit).not.toHaveBeenCalled();
    expect(input.value).toBe(draft);
    expect(screen.getByText("capture.png")).toBeTruthy();
    expect(discardImage).not.toHaveBeenCalled();
  });

  it("keeps every graphical instance mounted and routes commands only to the visible one", async () => {
    const listeners = new Set<Parameters<typeof window.codexAppServerApi.onChanged>[0]>();
    window.codexAppServerApi.onChanged = listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    };
    const sessions = ["run-1", "run-2"].map(id => ({ id, type: "windows", runtimeMode: "app-server", agentProvider: "codex" } as TerminalSession));
    const sessionRefs = new Map<string, CodexAppServerSessionHandle>();
    const onDraftChange = vi.fn();
    const onDraftReferencesChange = vi.fn();
    const onLinkClick = vi.fn();
    const panels = (activeId: string) => sessions.map(session => <GraphicalSessionPanel key={session.id} session={session}
      isActive={session.id === activeId} draft="" draftReferences={[]} onDraftChange={onDraftChange}
      onDraftReferencesChange={onDraftReferencesChange} onLinkClick={onLinkClick} sessionRefs={sessionRefs} />);

    const { container, rerender } = render(<>{panels("run-1")}</>);
    await waitFor(() => expect(window.codexAppServerApi.snapshot).toHaveBeenCalledTimes(1));
    expect(container.querySelectorAll(".graphical-session-panel")).toHaveLength(2);
    expect(sessionRefs.size).toBe(2);
    onDraftChange.mockClear();
    act(() => sessionRefs.get("run-2")?.appendFilePath("hidden.txt"));
    expect(onDraftChange).not.toHaveBeenCalled();

    rerender(<>{panels("run-2")}</>);
    expect(container.querySelectorAll(".graphical-session-panel")[0].getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll(".graphical-session-panel")[1].getAttribute("aria-hidden")).toBe("false");
    act(() => sessionRefs.get("run-1")?.appendFilePath("old.txt"));
    expect(onDraftChange).not.toHaveBeenCalled();
    act(() => sessionRefs.get("run-2")?.appendFilePath("active.txt"));
    expect(onDraftChange).toHaveBeenCalledWith("run-2", expect.any(Function));
    await waitFor(() => expect(window.codexAppServerApi.snapshot).toHaveBeenCalledTimes(2));
    act(() => listeners.forEach(listener => listener({ id: "run-1", snapshot: {
      threadId: "thread-1", mode: "default", executionPermission: "askApproval", busy: false, error: null,
      pendingPlan: null, items: [{ id: "answer-1", type: "agentMessage", text: "后台新消息" }], approvals: []
    } })));
    expect(container.textContent).not.toContain("后台新消息");
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({
      threadId: "thread-1", mode: "default", executionPermission: "askApproval", busy: false, error: null,
      pendingPlan: null, items: [{ id: "answer-1", type: "agentMessage", text: "后台新消息" }], approvals: []
    });
    rerender(<>{panels("run-1")}</>);
    await waitFor(() => expect(container.querySelectorAll(".graphical-session-panel")[0].textContent).toContain("后台新消息"));
    expect(window.codexAppServerApi.snapshot).toHaveBeenCalledTimes(3);

    rerender(<GraphicalSessionPanel session={sessions[1]} isActive draft="" draftReferences={[]}
      onDraftChange={onDraftChange} onDraftReferencesChange={onDraftReferencesChange}
      onLinkClick={onLinkClick} sessionRefs={sessionRefs} />);
    expect(sessionRefs.has("run-1")).toBe(false);
  });

  it("scrolls a graphical conversation to the bottom when switching back to it", async () => {
    const sessions = ["run-1", "run-2"].map(id => ({ id, type: "windows", runtimeMode: "app-server", agentProvider: "codex" } as TerminalSession));
    const sessionRefs = new Map<string, CodexAppServerSessionHandle>();
    const panels = (activeId: string) => sessions.map(session => <GraphicalSessionPanel key={session.id} session={session}
      isActive={session.id === activeId} draft="" draftReferences={[]} onDraftChange={vi.fn()}
      onDraftReferencesChange={vi.fn()} onLinkClick={vi.fn()} sessionRefs={sessionRefs} />);

    const { container, rerender } = render(<>{panels("run-1")}</>);
    await waitFor(() => expect(window.codexAppServerApi.snapshot).toHaveBeenCalledTimes(1));
    const messages = container.querySelectorAll<HTMLElement>(".codex-app-server-messages");
    Object.defineProperty(messages[0], "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(messages[1], "scrollHeight", { configurable: true, value: 800 });

    messages[0].scrollTop = 100;
    fireEvent.scroll(messages[0]);
    rerender(<>{panels("run-2")}</>);
    expect(messages[1].scrollTop).toBe(800);
    expect(messages[0].scrollTop).toBe(100);

    messages[1].scrollTop = 200;
    fireEvent.scroll(messages[1]);
    rerender(<>{panels("run-1")}</>);
    expect(messages[0].scrollTop).toBe(600);
    expect(messages[1].scrollTop).toBe(200);
  });

  it.each([
    { sessionType: "windows" as const, provider: "codex", visible: true },
    { sessionType: "wsl" as const, provider: "codex", visible: false },
    { sessionType: "ssh" as const, provider: "codex", visible: false },
    { sessionType: "windows" as const, provider: "codebuddy", visible: false }
  ])("limits sandbox setup entry to local Windows Codex: $sessionType / $provider", async ({ sessionType, provider, visible }) => {
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValue({ threadId: "thread-1", mode: "default", executionPermission: "askApproval",
      busy: false, error: null, pendingPlan: null, items: [], approvals: [], provider: provider as "codex" | "codebuddy",
      windowsSandboxSetup: { available: true, mode: "elevated", status: "running", error: null } });
    render(<SessionView sessionId="run-1" sessionType={sessionType} draft="hello" setDraft={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(Boolean(screen.queryByRole("menuitem", { name: "Windows 沙箱初始化" }))).toBe(visible);
    if (visible) {
      fireEvent.click(screen.getByRole("menuitem", { name: "Windows 沙箱初始化" }));
      expect(screen.getByRole("button", { name: "正在初始化…" })).toHaveProperty("disabled", true);
      expect(screen.getByRole("button", { name: "发送" })).toHaveProperty("disabled", true);
      fireEvent.click(screen.getByRole("button", { name: "关闭沙箱初始化" }));
      fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Windows 沙箱初始化" }));
      expect(screen.getByRole("status").textContent).toContain("正在初始化");
    }
  });

  it("shows Codex updates in the empty state instead of the actions menu", async () => {
    const check = vi.mocked(window.codexVersionApi.check);
    const update = vi.mocked(window.codexVersionApi.update);
    check.mockResolvedValue({ status: "available", currentVersion: "1.0.0", latestVersion: "1.1.0", method: "npm", environment: "Windows", restartRequired: false });
    update.mockResolvedValue({ status: "current", currentVersion: "1.1.0", latestVersion: "1.1.0", environment: "Windows", restartRequired: true });

    const { container } = render(<CodexAppServerSession sessionId="run-1" />);
    const emptyState = container.querySelector(".codex-app-server-empty")!;
    const updates = await screen.findByRole("group", { name: "Codex CLI 更新" });
    expect(emptyState.contains(updates)).toBe(true);
    await waitFor(() => expect(screen.getByText("1.1.0")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menu", { name: "会话操作" }).contains(updates)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "更新 Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "确认更新" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("run-1"));
    expect(await screen.findByText("更新已安装，手动重启会话后生效")).toBeTruthy();

    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false,
      error: null, items: [{ id: "user-1", type: "userMessage", text: "继续" }], approvals: [] } }));
    expect(container.querySelector(".codex-app-server-empty")).toBeNull();
    expect(screen.queryByRole("group", { name: "Codex CLI 更新" })).toBeNull();
  });

  it("checks and confirms CodeBuddy updates only in the empty state", async () => {
    const check = vi.mocked(window.codeBuddyVersionApi.check);
    const update = vi.mocked(window.codeBuddyVersionApi.update);
    check.mockResolvedValue({ status: "available", currentVersion: "2.55.0", latestVersion: "2.56.0", method: "npm", environment: "windows" });
    update.mockResolvedValue({ status: "current", currentVersion: "2.56.0", latestVersion: "2.56.0", environment: "windows", restartRequired: true });
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({ threadId: "thread-1", provider: "codebuddy", mode: "default",
      executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, items: [], approvals: [] });

    const { container } = render(<CodexAppServerSession sessionId="run-1" />);
    const updates = await screen.findByRole("group", { name: "CodeBuddy CLI 更新" });
    expect(container.querySelector(".codex-app-server-empty")?.contains(updates)).toBe(true);
    await waitFor(() => expect(check).toHaveBeenCalledWith("run-1"));
    fireEvent.click(await screen.findByRole("button", { name: "更新 CodeBuddy" }));
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认更新" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("run-1"));
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", provider: "codebuddy", mode: "default", busy: false,
      error: null, items: [{ id: "user-1", type: "userMessage", text: "继续" }], approvals: [] } }));
    expect(screen.queryByRole("group", { name: "CodeBuddy CLI 更新" })).toBeNull();
  });

  it("checks and confirms OpenCode V2 updates only in the empty state", async () => {
    const check = vi.mocked(window.openCodeVersionApi.check);
    const update = vi.mocked(window.openCodeVersionApi.update);
    check.mockResolvedValue({ status: "available", currentVersion: "2.0.18", latestVersion: "2.0.19", method: "npm", environment: "windows" });
    update.mockResolvedValue({ status: "current", currentVersion: "2.0.19", latestVersion: "2.0.19", environment: "windows", restartRequired: true });
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({ threadId: "thread-1", provider: "opencode", mode: "default",
      executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, items: [], approvals: [] });

    const { container } = render(<CodexAppServerSession sessionId="run-1" />);
    const updates = await screen.findByRole("group", { name: "OpenCode CLI 更新" });
    expect(container.querySelector(".codex-app-server-empty")?.contains(updates)).toBe(true);
    await waitFor(() => expect(check).toHaveBeenCalledWith("run-1"));
    fireEvent.click(screen.getByRole("button", { name: "更新 OpenCode" }));
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认更新" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("run-1"));
    expect(await screen.findByText("更新已安装，手动重启会话后生效")).toBeTruthy();
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", provider: "opencode", mode: "default", busy: false,
      error: null, items: [{ id: "user-1", type: "userMessage", text: "继续" }], approvals: [] } }));
    expect(screen.queryByRole("group", { name: "OpenCode CLI 更新" })).toBeNull();
  });

  it("reverts OpenCode messages with native semantics and preserves an existing draft", async () => {
    const base = { threadId: "ses_active", provider: "opencode" as const, mode: "default" as const,
      executionPermission: "askApproval" as const, busy: false, error: null, pendingPlan: null, approvals: [],
      capabilities: { history: true, plan: true, attachments: true, permissions: false, revertHistory: true },
      items: [{ id: "msg_first", type: "userMessage", text: "Original input", rewindMessageId: "msg_first" }] };
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce(base);
    revertThread.mockResolvedValueOnce({ ...base, items: [], openCodeRevert: { messageID: "msg_first" } });
    restoreThread.mockResolvedValueOnce(base);
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 OpenCode 发送消息");
    fireEvent.change(input, { target: { value: "Existing draft" } });
    fireEvent.click(screen.getByRole("button", { name: "回退到此处" }));
    expect(screen.getByRole("dialog", { name: "OpenCode 会话回退" })).toBeTruthy();
    expect(screen.queryByLabelText("仅对话")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认回退" }));
    await waitFor(() => expect(revertThread).toHaveBeenCalledWith("run-1", "msg_first"));
    expect(await screen.findByRole("button", { name: "恢复已撤销内容" })).toBeTruthy();
    expect(input).toHaveProperty("value", "Existing draft");
    fireEvent.click(screen.getByRole("button", { name: "取回原输入" }));
    expect(input).toHaveProperty("value", "Original input");
    fireEvent.click(screen.getByRole("button", { name: "恢复已撤销内容" }));
    await waitFor(() => expect(restoreThread).toHaveBeenCalledWith("run-1"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "恢复已撤销内容" })).toBeNull());
  });

  it("offers OpenCode history rename when the runtime supports it", async () => {
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({ threadId: "ses_active", provider: "opencode",
      mode: "default", executionPermission: "askApproval", pendingPlan: null, busy: false, error: null, items: [], approvals: [],
      capabilities: { history: true, plan: false, permissions: false, attachments: true, renameHistory: true } });
    listHistory.mockResolvedValueOnce({ data: [{ id: "ses_old", title: "Old title", updatedAt: 1, source: "OpenCode" }], nextCursor: null });
    render(<CodexAppServerSession sessionId="run-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    fireEvent.click(await screen.findByRole("button", { name: "重命名" }));
    fireEvent.change(screen.getByLabelText("重命名 Old title"), { target: { value: "New title" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(renameThread).toHaveBeenCalledWith("run-1", "ses_old", "New title"));
  });

  it("offers Windows CodeBuddy rewind only for messages with a stable ID", async () => {
    const messageId = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
    const base = { threadId: "thread-1", provider: "codebuddy" as const, mode: "default" as const,
      executionPermission: "askApproval" as const, busy: false, error: null, pendingPlan: null,
      capabilities: { history: true, plan: true, attachments: true, permissions: true, rewind: true },
      items: [{ id: "user-1", type: "userMessage", text: "First task", rewindMessageId: messageId },
        { id: "user-2", type: "userMessage", text: "No ID" }], approvals: [] };
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce(base);
    rewind.mockResolvedValueOnce({ snapshot: { ...base, items: [] }, filesChanged: [], historyRewound: true, fileRewindError: null });
    render(<CodexAppServerSession sessionId="run-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "回退到此处" }));
    expect(screen.getByRole("dialog", { name: "CodeBuddy 会话回退" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("仅对话"));
    fireEvent.click(screen.getByRole("button", { name: "确认回退" }));
    await waitFor(() => expect(rewind).toHaveBeenCalledWith("run-1", messageId, "Conversation"));
    expect(await screen.findByPlaceholderText("向 CodeBuddy 发送消息")).toHaveProperty("value", "First task");
  });

  it("shows a CodeBuddy error in its turn after the conversation continues", async () => {
    const detail = "429 您的使用量已超出频率限制，将在 2026-09-26 02:50:40 UTC+8 重置。\n(01a0d92020e4737f80c66dbc27673af9)";
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({ threadId: "thread-1", provider: "codebuddy",
      mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, items: [], approvals: [] });
    render(<CodexAppServerSession sessionId="run-1" />);
    const previous = [{ id: "user-1", type: "userMessage", turnId: "turn-1", text: "继续" },
      { id: "turn-error:turn-1", type: "turnError", turnId: "turn-1", text: detail }];
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", provider: "codebuddy", mode: "default",
      executionPermission: "askApproval", busy: false, error: null, items: previous, approvals: [] } }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(detail);
    expect(alert.textContent).toContain("CodeBuddy 运行错误");
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", provider: "codebuddy", mode: "default",
      executionPermission: "askApproval", busy: false, error: null,
      items: [...previous, { id: "user-2", type: "userMessage", turnId: "turn-2", text: "换个模型" }], approvals: [] } }));
    expect(screen.getByRole("alert").textContent).toContain(detail);
  });

  it("does not repeat a recorded CodeBuddy prompt error beside the composer", async () => {
    const detail = "429 您的使用量已超出频率限制。";
    const initial = { threadId: "thread-1", provider: "codebuddy" as const, mode: "default" as const,
      executionPermission: "askApproval" as const, busy: false, error: null, pendingPlan: null, items: [], approvals: [] };
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce(initial).mockResolvedValue({ ...initial,
      items: [{ id: "turn-error:turn-1", type: "turnError", turnId: "turn-1", text: detail }] });
    submit.mockReset().mockRejectedValueOnce(new Error(detail));
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 CodeBuddy 发送消息");
    fireEvent.change(screen.getByRole("textbox", { name: "图形对话输入" }), { target: { value: "继续" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(window.codexAppServerApi.snapshot).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "关闭错误提示" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement).value).toBe("");
  });

  it("hides the runtime strip while retaining diagnostics and the latest per-turn diff", async () => {
    const { container } = render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", executionPermission: "askApproval",
      busy: true, error: null, items: [{ id: "user-1", type: "userMessage", turnId: "turn-1", text: "修改文件" }], approvals: [],
      threadStatus: { type: "active", activeFlags: ["waitingOnApproval"] }, model: "primary", effectiveModel: "fallback",
      diagnostics: [{ id: "1", turnId: "turn-1", kind: "hook/completed", at: 1000,
        payload: { run: { name: "PreToolUse", status: "failed", output: "detail" } } },
        { id: "2", turnId: "turn-1", kind: "error", at: 1100,
          payload: { message: "limit", kind: "UsageLimitExceeded", httpStatusCode: 429 } }],
      turnDiffs: [{ turnId: "turn-1", diff: "diff --git a/a b/a", updatedAt: 1200 }] } }));
    expect(container.querySelector(".codex-app-server-runtime")).toBeNull();
    expect(screen.queryByText("等待操作确认")).toBeNull();
    expect(screen.queryByText("实际模型：fallback")).toBeNull();
    fireEvent.click(screen.getByText("运行错误"));
    expect(screen.getByText("类别：用量限制 · HTTP 429")).toBeTruthy();
    fireEvent.click(screen.getByText("本轮变更"));
    expect(screen.getByText("diff --git a/a b/a")).toBeTruthy();
    expect(screen.queryByText(/Hook 消息|Hook 完成|PreToolUse/)).toBeNull();
  });

  it("shows account login only while the Codex account is signed out", async () => {
    const signedOut = { status: "signedOut" as const, requiresOpenaiAuth: true, account: null, login: null,
      rateLimits: null, usage: null, rateLimitsError: null, usageError: null, error: null };
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({ threadId: "thread-1", mode: "default",
      executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, items: [], approvals: [], account: signedOut });
    const { container } = render(<CodexAppServerSession sessionId="run-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "未登录" }));
    expect(screen.getByRole("region", { name: "Codex 账号管理" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "使用 ChatGPT 登录" })).toBeTruthy();
    expect(screen.getByPlaceholderText("请先登录 Codex 账号")).toHaveProperty("disabled", true);
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", executionPermission: "askApproval",
      busy: false, error: null, items: [], approvals: [], account: { ...signedOut, status: "signedIn",
        account: { type: "chatgpt", email: "user@example.com", planType: "plus" } } } }));
    expect(container.querySelector(".codex-account")).toBeNull();
    expect(screen.queryByRole("button", { name: "未登录" })).toBeNull();
    expect(screen.getByPlaceholderText("向 Codex 发送消息")).toHaveProperty("disabled", false);
  });

  it.each(["codebuddy", "opencode"] as const)("does not show the Codex account panel in %s sessions", async provider => {
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({ threadId: "thread-1", provider,
      mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null,
      items: [], approvals: [], account: { status: "signedOut", requiresOpenaiAuth: true, account: null,
        login: null, rateLimits: null, usage: null, rateLimitsError: null, usageError: null, error: null } });
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByRole("region", { name: `${provider === "codebuddy" ? "CodeBuddy" : "OpenCode"} 图形会话` });
    expect(screen.queryByRole("button", { name: "未登录" })).toBeNull();
  });

  it("hides Hook messages from the timeline while retaining other diagnostics", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, approvals: [],
      items: [{ id: "user-1", turnId: "turn-1", type: "userMessage", text: "检查" }], diagnostics: [
        { id: "hook-1", turnId: "turn-1", kind: "hook/started", at: 1000, payload: { run: { name: "PreToolUse" } } },
        { id: "hook-2", turnId: "turn-1", kind: "hook/completed", at: 1100, payload: { run: { name: "PreToolUse", output: "结果" } } },
        { id: "warning-1", turnId: "turn-1", kind: "warning", at: 1200, payload: { message: "注意" } },
        { id: "hook-3", turnId: "turn-1", kind: "hook/started", at: 1300, payload: { run: { name: "Stop" } } },
        { id: "hook-4", turnId: "turn-2", kind: "hook/completed", at: 1400, payload: { run: { name: "Other" } } }
      ] } }));
    expect(screen.queryByText(/Hook 消息|Hook 开始|Hook 完成|PreToolUse|Stop|Other/)).toBeNull();
    expect(screen.getByText("运行警告")).toBeTruthy();
    fireEvent.click(screen.getByText("运行警告"));
    expect(screen.getByText(/"message": "注意"/)).toBeTruthy();
  });

  it("keeps a Codex error card after the transient error clears", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false,
      error: null, approvals: [], items: [{ id: "user-1", turnId: "turn-1", type: "userMessage", text: "检查" }],
      diagnostics: [{ id: "error-1", turnId: "turn-1", kind: "error", at: 1000,
        payload: { message: "额度不足", kind: "UsageLimitExceeded", httpStatusCode: 429 } }] } }));
    expect(screen.getByText("运行错误")).toBeTruthy();
    expect(screen.getByText("额度不足")).toBeTruthy();
    fireEvent.click(screen.getByText("运行错误"));
    expect(screen.getByText("类别：用量限制 · HTTP 429")).toBeTruthy();
  });

  it("opens review from the menu without losing the draft or attachments and blocks sending during review", async () => {
    window.codexAppServerApi.startReview = vi.fn().mockResolvedValue(undefined);
    chooseFiles.mockResolvedValueOnce(["C:\\project\\notes.txt"]);
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    const composer = screen.getByPlaceholderText("向 Codex 发送消息");
    fireEvent.change(composer, { target: { value: "保留草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "附加文件" }));
    await screen.findByRole("button", { name: "预览 notes.txt" });
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "代码审查" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(composer).toHaveProperty("value", "保留草稿");
    expect(screen.getByRole("button", { name: "预览 notes.txt" })).toBeTruthy();
    expect(window.codexAppServerApi.startReview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "代码审查" }));
    fireEvent.click(screen.getByRole("button", { name: "开始审查" }));
    await waitFor(() => expect(window.codexAppServerApi.startReview).toHaveBeenCalledWith("run-1", { type: "uncommittedChanges" }));
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, reviewing: true, error: null, items: [], approvals: [] } }));
    expect(composer).toHaveProperty("disabled", true);
    expect(composer).toHaveProperty("value", "保留草稿");
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false, reviewing: false, error: null,
      items: [{ id: "r", type: "exitedReviewMode", review: "没有发现问题" }], approvals: [] } }));
    expect(composer).toHaveProperty("disabled", false);
    expect(screen.getByText("没有发现问题")).toBeTruthy();
  });

  it("opens review through the local slash command", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const composer = await screen.findByPlaceholderText("向 Codex 发送消息");
    await waitFor(() => expect(composer).toHaveProperty("disabled", false));
    fireEvent.change(composer, { target: { value: "/review" } });
    fireEvent.click(screen.getByRole("option", { name: "/review 代码审查" }));
    expect(screen.getByRole("dialog", { name: "代码审查" })).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it("starts compaction from the Codex menu and prevents another submission while it runs", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "压缩对话" }));
    await waitFor(() => expect(compactThread).toHaveBeenCalledWith("run-1"));
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", executionPermission: "askApproval",
      busy: true, compacting: true, compactionStatus: "running", error: null, items: [], approvals: [] } }));
    expect(screen.getByText("正在压缩当前会话，请等待完成…")).toBeTruthy();
    expect(screen.getByPlaceholderText("向 Codex 发送消息")).toHaveProperty("disabled", true);
  });

  it.each(["running", "completed", "failed"] as const)("shows Codex compaction %s only in the bottom status", async status => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", provider: "codex",
      busy: status === "running", compacting: status === "running", compactionStatus: status, error: null,
      items: [{ id: "compact-1", type: "contextCompaction", status: status === "running" ? "inProgress" : status }], approvals: [] } }));
    const messages = document.querySelector(".codex-app-server-messages")!;
    expect(messages.querySelector(".context-compaction")).toBeNull();
    expect(screen.queryByText("上下文压缩完成")).toBeNull();
    const bottomStatus = messages.querySelector(".codex-app-server-compaction-status");
    if (status === "completed") expect(bottomStatus).toBeNull();
    else {
      expect(bottomStatus?.textContent).toBe(status === "running" ? "正在压缩当前会话，请等待完成…" : "上下文压缩失败，请重试。");
      expect(bottomStatus?.getAttribute("role")).toBe(status === "running" ? "status" : "alert");
    }
    expect(screen.getByPlaceholderText("向 Codex 发送消息")).toHaveProperty("disabled", status === "running");
  });

  it("creates, pauses, and clears a thread goal with server usage", async () => {
    const base = { threadId: "thread-1", mode: "default" as const, executionPermission: "askApproval" as const,
      busy: false, error: null, pendingPlan: null, items: [], approvals: [] };
    const goal = { threadId: "thread-1", objective: "完成迁移", status: "active", tokenBudget: 2000,
      tokensUsed: 300, timeUsedSeconds: 12 };
    setGoal.mockImplementation(async (_id, changes) => ({ ...base, goal: { ...goal, ...changes } }));
    clearGoal.mockResolvedValue({ ...base, goal: null });
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "目标管理" }));
    expect(getGoal).toHaveBeenCalledWith("run-1");
    fireEvent.change(screen.getByPlaceholderText("写下预期结果和完成条件"), { target: { value: "完成迁移" } });
    fireEvent.change(screen.getByPlaceholderText("不限制"), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: "创建目标" }));
    await waitFor(() => expect(setGoal).toHaveBeenCalledWith("run-1", { objective: "完成迁移", status: "active", tokenBudget: 2000 }));
    expect(await screen.findByText("已用 300 Token / 2000 Token")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(setGoal).toHaveBeenCalledWith("run-1", { status: "paused" }));
    fireEvent.click(screen.getByRole("button", { name: "清除目标" }));
    expect(clearGoal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认清除" }));
    await waitFor(() => expect(clearGoal).toHaveBeenCalledWith("run-1"));
  });

  it("confirms a goal replacement before resetting usage", async () => {
    setGoal.mockResolvedValue({ threadId: "thread-1", mode: "default", executionPermission: "askApproval", busy: false,
      error: null, items: [], approvals: [], goal: { threadId: "thread-1", objective: "新目标", status: "active",
        tokensUsed: 0, timeUsedSeconds: 0 } });
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", executionPermission: "askApproval",
      busy: false, error: null, items: [], approvals: [], goal: { threadId: "thread-1", objective: "旧目标",
        status: "active", tokensUsed: 500, timeUsedSeconds: 20 } } }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "目标管理" }));
    fireEvent.change(screen.getByPlaceholderText("写下预期结果和完成条件"), { target: { value: "新目标" } });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    expect(setGoal).not.toHaveBeenCalled();
    expect(screen.getByText(/更换目标内容会重置/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认更换" }));
    await waitFor(() => expect(setGoal).toHaveBeenCalledWith("run-1", { objective: "新目标", status: "active", tokenBudget: null }));
  });

  it("hides Codex thread actions for CodeBuddy graphical sessions", async () => {
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({ threadId: "buddy-1", provider: "codebuddy",
      mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null,
      items: [], approvals: [] });
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.queryByRole("menuitem", { name: "Skills、Apps 和 MCP" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "压缩对话" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "目标管理" })).toBeTruthy();
  });

  it("inserts capabilities into the draft and sends only retained structured references", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    expect(screen.queryByRole("button", { name: "Skills、Apps 和 MCP" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Skills、Apps 和 MCP" }));
    expect(screen.queryByRole("menu", { name: "会话操作" })).toBeNull();
    expect(await screen.findByRole("button", { name: /^review/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^review/ }));
    const input = screen.getByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    expect(input.value).toContain("$review");
    fireEvent.change(input, { target: { value: "请检查" } });
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Skills、Apps 和 MCP" }));
    fireEvent.click(screen.getByRole("tab", { name: "Apps" }));
    fireEvent.click(await screen.findByRole("button", { name: /GitHub/ }));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "请检查 $github", [], [
      { kind: "app", name: "GitHub", path: "app://github", token: "$github" }
    ]));
  });

  it("inserts an MCP tool hint without making a direct tool call", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Skills、Apps 和 MCP" }));
    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    fireEvent.click(await screen.findByRole("button", { name: /read_file/ }));
    expect((screen.getByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement).value).toContain("mcp__files__read_file");
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "请使用 MCP 工具 mcp__files__read_file", [], []));
  });

  it("closes the capability picker with Escape and restores focus to more actions", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const more = screen.getByRole("button", { name: "更多操作" });
    await waitFor(() => expect(more).toHaveProperty("disabled", false));
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Skills、Apps 和 MCP" }));
    const picker = screen.getByRole("dialog", { name: "选择会话能力" });
    fireEvent.keyDown(picker, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "选择会话能力" })).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("suggests slash operations only at the start and executes the selected operation", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息");
    fireEvent.change(input, { target: { value: "请执行 /new" } });
    expect(screen.queryByRole("listbox", { name: "会话操作联想" })).toBeNull();
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getByRole("option", { name: "/new 新对话" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "/skills Skills 列表" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "/mcp MCP 列表" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "/plugins 插件管理" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "/compact 压缩对话" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "/new" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(newThread).toHaveBeenCalledWith("run-1"));
    expect(submit).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("disables and enables skills without changing the draft or closing the picker", async () => {
    const caps = (enabled: boolean) => ({ skills: [{ name: "review", path: "C:/skills/review/SKILL.md", enabled, description: "Review", scope: "user" }], apps: [], mcp: [], errors: {} });
    listCapabilities.mockResolvedValueOnce(caps(true)).mockResolvedValueOnce(caps(false)).mockResolvedValueOnce(caps(true));
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息");
    fireEvent.change(input, { target: { value: "/skills" } }); fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.change(input, { target: { value: "保留草稿" } });
    fireEvent.click(await screen.findByRole("button", { name: "禁用技能 review" }));
    await screen.findByRole("button", { name: "启用技能 review" });
    expect(setSkillEnabled).toHaveBeenCalledWith("run-1", "C:/skills/review/SKILL.md", false);
    expect((screen.getByText("已停用").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect((input as HTMLTextAreaElement).value).toBe("保留草稿");
    fireEvent.click(screen.getByRole("button", { name: "启用技能 review" }));
    await screen.findByRole("button", { name: "禁用技能 review" });
    expect(setSkillEnabled).toHaveBeenLastCalledWith("run-1", "C:/skills/review/SKILL.md", true);
    expect(screen.getByRole("dialog", { name: "选择会话能力" })).toBeTruthy();
  });
  it("keeps the old skill state on write failure and distinguishes refresh failure", async () => {
    setSkillEnabled.mockRejectedValueOnce(new Error("保存失败"));
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息");
    fireEvent.change(input, { target: { value: "/skills" } }); fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.click(await screen.findByRole("button", { name: "禁用技能 review" }));
    await screen.findByText("保存失败");
    expect(screen.getByRole("button", { name: "禁用技能 review" })).toBeTruthy();
    listCapabilities.mockResolvedValueOnce({ skills: [], apps: [], mcp: [], errors: { skills: "读取失败" } });
    fireEvent.click(screen.getByRole("button", { name: "禁用技能 review" }));
    await screen.findByText("已保存，刷新失败：读取失败");
    expect(setSkillEnabled).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "刷新能力" })).toBeTruthy();
  });
  it("guards duplicate skill writes and ignores completion after switching sessions", async () => {
    let complete!: () => void;
    setSkillEnabled.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    const view = render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息");
    fireEvent.change(input, { target: { value: "/skills" } }); fireEvent.keyDown(input, { key: "Tab" });
    const button = await screen.findByRole("button", { name: "禁用技能 review" });
    fireEvent.click(button); fireEvent.click(button);
    expect(setSkillEnabled).toHaveBeenCalledTimes(1);
    view.rerender(<CodexAppServerSession sessionId="run-2" />);
    const reads = listCapabilities.mock.calls.length;
    await act(async () => complete());
    expect(listCapabilities).toHaveBeenCalledTimes(reads);
    expect(screen.queryByText(/已保存，刷新失败/)).toBeNull();
  });
  it("prevents skill setting changes while the conversation is running", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息");
    fireEvent.change(input, { target: { value: "/skills" } }); fireEvent.keyDown(input, { key: "Tab" });
    await screen.findByRole("button", { name: "禁用技能 review" });
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [], approvals: [] } }));
    const button = screen.getByRole("button", { name: "禁用技能 review" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); fireEvent.click(button);
    expect(setSkillEnabled).not.toHaveBeenCalled();
  });
  it("opens capability tabs and existing settings from slash suggestions", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息");
    fireEvent.change(input, { target: { value: "/mcp" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(await screen.findByRole("dialog", { name: "选择会话能力" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "MCP" }).getAttribute("aria-selected")).toBe("true");
    expect(listCapabilities).toHaveBeenCalledWith("run-1", true);
    fireEvent.change(input, { target: { value: "/mode" } });
    fireEvent.click(screen.getByRole("option", { name: "/mode 模式" }));
    expect(screen.getByRole("dialog", { name: "模式" })).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it("supports filtering, arrow navigation, Escape, and direct compaction", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息");
    fireEvent.change(input, { target: { value: "/历史" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "会话操作联想" })).toBeNull();
    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "/history 历史会话" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.change(input, { target: { value: "/compact" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(compactThread).toHaveBeenCalledWith("run-1"));
    expect(submit).not.toHaveBeenCalled();
  });

  it("shows provider-supported slash operations in CodeBuddy sessions", async () => {
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({ threadId: "buddy-1", provider: "codebuddy",
      mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null,
      items: [], approvals: [], capabilities: { history: false, plan: true, attachments: true, permissions: true } });
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 CodeBuddy 发送消息");
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getByRole("option", { name: "/new 新对话" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "/mode 模式" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "/goal 目标管理" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Skills|MCP|压缩对话/ })).toBeNull();
    expect(screen.getByRole("option", { name: "/history 历史会话" })).toHaveProperty("disabled", true);
  });

  it("suggests current CodeBuddy commands, keeps local name collisions, and inserts a selected command", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "buddy-1", provider: "codebuddy",
      mode: "default", executionPermission: "askApproval", busy: false, error: null, items: [], approvals: [],
      availableCommands: [{ name: "review", description: "Review code" }, { name: "mode", description: "Agent mode" }] } }));
    const input = screen.getByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/rev" } });
    expect(screen.getByRole("option", { name: "/review Review code" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "/review Review code" }));
    expect(input.value).toBe("/review ");
    expect(submit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "/review src" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "/review src", [], []));
    fireEvent.change(input, { target: { value: "/mode" } });
    expect(screen.getAllByRole("option", { name: /\/mode/ })).toHaveLength(1);
    act(() => changed({ id: "run-1", snapshot: { threadId: "buddy-1", provider: "codebuddy",
      mode: "default", executionPermission: "askApproval", busy: false, error: null, items: [], approvals: [],
      availableCommands: [{ name: "fix", description: "Fix issue" }] } }));
    fireEvent.change(input, { target: { value: "/rev" } });
    expect(screen.queryByRole("option", { name: /\/review/ })).toBeNull();
    fireEvent.change(input, { target: { value: "/fix" } });
    expect(screen.getByRole("option", { name: "/fix Fix issue" })).toBeTruthy();
  });

  it("keeps OpenCode slash suggestions limited to its available controls", async () => {
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({ threadId: "open-1", provider: "opencode",
      mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null,
      items: [], approvals: [], capabilities: { history: true, plan: true, attachments: true, permissions: true } });
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 OpenCode 发送消息");
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getByRole("option", { name: "/new 新对话" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "/history 历史会话" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Skills|Apps|MCP|压缩对话|插件管理/ })).toBeNull();
  });

  it("suggests OpenCode ACP commands and sends a selected compact command", async () => {
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({ threadId: "open-1", provider: "opencode",
      mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null,
      items: [], approvals: [], capabilities: { history: true, plan: true, attachments: true, permissions: true },
      availableCommands: [{ name: "compact", description: "Compact conversation" },
        { name: "review", description: "Review code" }, { name: "mode", description: "Agent mode" }] });
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 OpenCode 发送消息") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/compact" } });
    fireEvent.click(screen.getByRole("option", { name: "/compact Compact conversation" }));
    expect(input.value).toBe("/compact ");
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "/compact", [], []));
    fireEvent.change(input, { target: { value: "/mode" } });
    expect(screen.getAllByRole("option", { name: /\/mode/ })).toHaveLength(1);
  });

  it("shows OpenCode session skills and MCP tools and inserts hints", async () => {
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({ threadId: "open-1", provider: "opencode",
      mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null,
      items: [], approvals: [], capabilities: { history: true, plan: true, attachments: true, permissions: true } });
    const openCapabilities = { skills: [{ id: "review", name: "Review", path: "C:/skills/review/SKILL.md",
      description: "Review code", enabled: true, scope: "project" }], apps: [],
    mcp: [{ name: "files", status: "connected", authStatus: "unknown", toolsError: null,
      tools: [{ name: "files_read_file", description: "Read file" }] }], errors: {} };
    listCapabilities.mockResolvedValueOnce(openCapabilities).mockResolvedValueOnce(openCapabilities);
    render(<CodexAppServerSession sessionId="run-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Skills 和 MCP" }));
    expect(screen.queryByRole("tab", { name: "Apps" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /Review/ }));
    expect((screen.getByPlaceholderText("向 OpenCode 发送消息") as HTMLTextAreaElement).value).toContain("skill 工具加载 review");
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Skills 和 MCP" }));
    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    fireEvent.click(await screen.findByRole("button", { name: /files_read_file/ }));
    expect((screen.getByPlaceholderText("向 OpenCode 发送消息") as HTMLTextAreaElement).value).toContain("MCP 工具 files_read_file");
    expect(submit).not.toHaveBeenCalled();
  });

  it("shows CodeBuddy modes supplied by ACP and hides Codex permission controls", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "buddy-1", provider: "codebuddy", nativeMode: "default",
      nativeModes: [{ id: "default", name: "Standard" }, { id: "plan", name: "Plan" }], mode: "default",
      executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, items: [], approvals: [],
      capabilities: { history: false, plan: true, attachments: true, permissions: true } } }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "历史会话" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("menuitem", { name: /执行权限/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /^模式/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Plan/ }));
    await waitFor(() => expect(setNativeMode).toHaveBeenCalledWith("run-1", "plan"));
  });

  it("shows Chinese descriptions for CodeBuddy native modes", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "buddy-1", provider: "codebuddy", nativeMode: "default",
      nativeModes: [
        { id: "default", name: "Standard", description: "Autonomous coding agent" },
        { id: "plan", name: "Plan", description: "Plan before acting" },
        { id: "auto", name: "Auto", description: "Act without asking" },
        { id: "dontAsk", name: "Dont Ask", description: "Never prompt" },
        { id: "delegate", name: "Delegate", description: "Hand off to subagents" }
      ], mode: "default",
      executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, items: [], approvals: [],
      capabilities: { history: false, plan: true, attachments: true, permissions: true } } }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^模式/ }));
    expect(screen.getByText("自主分析并执行任务，可读取与修改文件、运行命令。")).toBeTruthy();
    expect(screen.getByText("先制定计划并等待你确认，再开始执行（只读，不直接改动文件）。")).toBeTruthy();
    expect(screen.getByText("自主分析并执行任务，遇到需确认的操作自动放行。")).toBeTruthy();
    expect(screen.getByText("运行命令与修改文件均不再弹出确认。")).toBeTruthy();
    expect(screen.getByText("将子任务委派给子 Agent 并行处理。")).toBeTruthy();
    expect(screen.queryByText("Autonomous coding agent")).toBeNull();
    expect(screen.queryByText("Plan before acting")).toBeNull();
    expect(screen.queryByText("Act without asking")).toBeNull();
    expect(screen.queryByText("Never prompt")).toBeNull();
    expect(screen.queryByText("Hand off to subagents")).toBeNull();
  });

  it("selects CodeBuddy main agents, preserves drafts, and locks existing conversations", async () => {
    const base = { threadId: "buddy-1", provider: "codebuddy" as const, mode: "default" as const,
      executionPermission: "askApproval" as const, busy: false, error: null, pendingPlan: null, approvals: [], items: [],
      mainAgent: { currentAgentName: "cli", sessionBlank: true, error: null, agents: [
        { name: "cli", displayName: "标准", source: "built-in" },
        { name: "reviewer", displayName: "审查员", source: "project", description: "审查代码" },
        { name: "broken", displayName: "损坏", broken: "配置错误" }] } };
    const listMainAgents = vi.fn().mockResolvedValue(base);
    let finishSwitch!: (value: typeof base) => void;
    const setMainAgent = vi.fn().mockImplementation(() => new Promise(resolve => { finishSwitch = resolve; }));
    Object.assign(window.codexAppServerApi, { listMainAgents, setMainAgent });
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: base }));
    fireEvent.change(screen.getByRole("textbox", { name: "图形对话输入" }), { target: { value: "保留草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "主 Agent：标准" }));
    await waitFor(() => expect(listMainAgents).toHaveBeenCalledWith("run-1"));
    await waitFor(() => expect((screen.getByRole("radio", { name: /审查员/ }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("radio", { name: /损坏/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /审查员/ }));
    await waitFor(() => expect(setMainAgent).toHaveBeenCalledWith("run-1", "reviewer"));
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "新对话" }) as HTMLButtonElement).disabled).toBe(true);
    const priorSubmits = submit.mock.calls.length;
    fireEvent.submit(screen.getByRole("textbox", { name: "图形对话输入" }).closest("form")!);
    expect(submit.mock.calls.length).toBe(priorSubmits);
    await act(async () => finishSwitch({ ...base, mainAgent: { ...base.mainAgent, currentAgentName: "reviewer" } }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "主 Agent" })).toBeNull());
    expect((screen.getByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement).value).toBe("保留草稿");
    const locked = { ...base, mainAgent: { ...base.mainAgent, currentAgentName: "reviewer", sessionBlank: false } };
    listMainAgents.mockResolvedValue(locked);
    act(() => changed({ id: "run-1", snapshot: locked }));
    fireEvent.click(screen.getByRole("button", { name: /主 Agent：审查员/ }));
    await waitFor(() => expect(screen.getByText("新建对话后可切换主 Agent。")).toBeTruthy());
    expect((screen.getByRole("radio", { name: /标准/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("retries CodeBuddy main agent discovery and hides the selector for other providers", async () => {
    const base = { threadId: "buddy-1", provider: "codebuddy" as const, mode: "default" as const,
      executionPermission: "askApproval" as const, busy: false, error: null, pendingPlan: null, approvals: [], items: [],
      mainAgent: { currentAgentName: null, sessionBlank: false, error: "目录读取失败", agents: [] } };
    const listMainAgents = vi.fn().mockResolvedValue(base);
    Object.assign(window.codexAppServerApi, { listMainAgents });
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: base }));
    fireEvent.click(screen.getByRole("button", { name: "主 Agent：未读取" }));
    await waitFor(() => expect(screen.getByText("目录读取失败")).toBeTruthy());
    await waitFor(() => expect((screen.getByRole("button", { name: "刷新主 Agent" }) as HTMLButtonElement).disabled).toBe(false));
    listMainAgents.mockResolvedValue({ ...base, mainAgent: { currentAgentName: "cli", sessionBlank: true, error: null,
      agents: [{ name: "cli", displayName: "标准" }] } });
    fireEvent.click(screen.getByRole("button", { name: "刷新主 Agent" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /标准/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "关闭主 Agent" }));
    act(() => changed({ id: "run-1", snapshot: { ...base, provider: "opencode" } }));
    expect(screen.queryByRole("button", { name: /主 Agent：/ })).toBeNull();
  });

  it("shows Multitask only when CodeBuddy advertises it and renders background summaries", async () => {
    const base = { threadId: "buddy-1", provider: "codebuddy" as const, mode: "default" as const,
      executionPermission: "askApproval" as const, busy: false, error: null, pendingPlan: null,
      nativeModes: [], approvals: [], items: [], acpOptions: [{ id: "multitask", name: "Multitask", type: "boolean", currentValue: false }] };
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { ...base, capabilities: { history: false, plan: false, attachments: true, permissions: true } } }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.queryByRole("menuitem", { name: /Multitask/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    act(() => changed({ id: "run-1", snapshot: { ...base, capabilities: { history: false, plan: false, attachments: true, permissions: true, multitask: true } } }));
    setMultitask.mockResolvedValueOnce({ ...base, capabilities: { history: false, plan: false, attachments: true, permissions: true, multitask: true },
      acpOptions: [{ ...base.acpOptions[0], currentValue: true }] });
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Multitask/ }));
    fireEvent.click(screen.getByRole("radio", { name: "开启" }));
    await waitFor(() => expect(setMultitask).toHaveBeenCalledWith("run-1", true));
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" }).getAttribute("aria-expanded")).toBe("false"));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Multitask/ }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "开启" }).getAttribute("aria-checked")).toBe("true"));
    act(() => changed({ id: "run-1", snapshot: { ...base, capabilities: { history: false, plan: false, attachments: true, permissions: true, multitask: true },
      items: [{ id: "background-turn:drain", type: "backgroundTurn", turnId: "drain" },
        { id: "answer", type: "agentMessage", turnId: "drain", text: "子任务已完成" }],
      approvals: [{ requestId: 500, method: "session/request_permission", params: { reason: "子任务提问", choices: [{ id: "yes", label: "继续" }] } }] } }));
    expect(screen.getByText("后台任务汇总")).toBeTruthy();
    expect(screen.getByText("子任务已完成")).toBeTruthy();
    expect(screen.getByText("子任务提问")).toBeTruthy();
  });

  it("retains the Multitask state when ACP rejects a change", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "buddy-1", provider: "codebuddy", mode: "default",
      executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, items: [], approvals: [], nativeModes: [],
      capabilities: { history: false, plan: false, attachments: true, permissions: true, multitask: true },
      acpOptions: [{ id: "multitask", name: "Multitask", type: "boolean", currentValue: false }] } }));
    setMultitask.mockRejectedValueOnce(new Error("后台任务已禁用"));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Multitask/ }));
    fireEvent.click(screen.getByRole("radio", { name: "开启" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Multitask" }).textContent).toContain("后台任务已禁用"));
    expect(screen.getByRole("radio", { name: "关闭" }).getAttribute("aria-checked")).toBe("true");
  });

  it("shows CodeBuddy ACP models and switches the selected model", async () => {
    const modelOptions = [{ value: "hy3", name: "HY3" }, { value: "glm-5.3", name: "GLM 5.3" }];
    const base = { threadId: "buddy-1", provider: "codebuddy" as const, nativeMode: "default",
      nativeModes: [{ id: "default", name: "Standard" }], mode: "default" as const,
      executionPermission: "askApproval" as const, busy: false, error: null, pendingPlan: null, items: [], approvals: [] };
    const withModel = (currentValue: string) => ({ ...base, acpOptions: [{ id: "model", type: "select",
      currentValue, options: modelOptions }] });
    setModel.mockResolvedValueOnce(withModel("glm-5.3"));
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: withModel("hy3") }));
    expect(screen.getByText("HY3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^模型 / }));
    expect(screen.getByRole("dialog", { name: "模型" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "HY3" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "GLM 5.3" }));
    await waitFor(() => expect(setModel).toHaveBeenCalledWith("run-1", "glm-5.3"));
    expect(await screen.findByText("GLM 5.3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /模型/ }));
    expect(screen.getByRole("radio", { name: "GLM 5.3" }).getAttribute("aria-checked")).toBe("true");
    act(() => changed({ id: "run-1", snapshot: { ...withModel("glm-5.3"), busy: true } }));
    expect(screen.getByRole("radio", { name: "HY3" })).toHaveProperty("disabled", true);
  });

  it("shows current CodeBuddy multiplier and discount in the model menu and status", async () => {
    listModelMetadata.mockResolvedValue([{ id: "hy3", creditMultiplier: "0x", promotions: [{ id: "night", label: "夜间折扣" }] }]);
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "buddy-1", provider: "codebuddy", mode: "default",
      executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, items: [], approvals: [],
      acpOptions: [{ id: "model", type: "select", currentValue: "hy3", options: [
        { value: "hy3", name: "HY3" }, { value: "other", name: "Other" }] }] } }));
    await waitFor(() => expect(screen.getByText("HY3 · 倍率 0x · 夜间折扣")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /模型/ }));
    expect(await screen.findByRole("radio", { name: /HY3.*倍率 0x · 夜间折扣/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Other" })).toBeTruthy();
  });

  it.each(["missing", "throws", "rejects", "invalid response"])("keeps the CodeBuddy session visible when model metadata %s", async failure => {
    if (failure === "missing") Object.defineProperty(window.codexAppServerApi, "listModelMetadata", { configurable: true, value: undefined });
    else if (failure === "throws") listModelMetadata.mockImplementationOnce(() => { throw new Error("Metadata unavailable"); });
    else if (failure === "rejects") listModelMetadata.mockRejectedValueOnce(new Error("Metadata unavailable"));
    else listModelMetadata.mockResolvedValueOnce({ invalid: true });

    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "buddy-1", provider: "codebuddy", mode: "default",
      executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, items: [], approvals: [],
      acpOptions: [{ id: "model", type: "select", currentValue: "hy3", options: [{ value: "hy3", name: "HY3" }] }] } }));
    await act(async () => {});
    expect(screen.getByRole("region", { name: "CodeBuddy 图形会话" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /模型/ }));
    expect(screen.getByRole("radio", { name: "HY3" })).toBeTruthy();
  });

  it("hides missing CodeBuddy model options and reports a rejected model change", async () => {
    const base = { threadId: "buddy-1", provider: "codebuddy" as const, nativeMode: "default",
      nativeModes: [], mode: "default" as const, executionPermission: "askApproval" as const,
      busy: false, error: null, pendingPlan: null, items: [], approvals: [] };
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: base }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.queryByRole("menuitem", { name: /模型/ })).toBeNull();
    act(() => changed({ id: "run-1", snapshot: { ...base, acpOptions: [{ id: "model", type: "select",
      currentValue: "hy3", options: [{ value: "hy3", name: "HY3" }, { value: "glm-5.3", name: "GLM 5.3" }] }] } }));
    setModel.mockRejectedValueOnce(new Error("Model unavailable"));
    fireEvent.click(screen.getByRole("menuitem", { name: /模型/ }));
    fireEvent.click(screen.getByRole("radio", { name: "GLM 5.3" }));
    await waitFor(() => expect(setModel).toHaveBeenCalledWith("run-1", "glm-5.3"));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "模型" }).textContent).toContain("Model unavailable"));
    expect(screen.getByRole("radio", { name: "HY3" }).getAttribute("aria-checked")).toBe("true");
  });

  it("shows only advertised CodeBuddy context tiers and keeps the choice after a rejection", async () => {
    const base = { threadId: "buddy-1", provider: "codebuddy" as const, nativeMode: "default", nativeModes: [],
      mode: "default" as const, executionPermission: "askApproval" as const,
      busy: false, error: null, pendingPlan: null, items: [], approvals: [] };
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: base }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.queryByRole("menuitem", { name: /上下文窗口/ })).toBeNull();
    const withTiers = { ...base, acpOptions: [{ id: "context_window", type: "select", currentValue: "200000",
      options: [{ value: "200000", name: "200K" }, { value: "1000000", name: "1M" }] }] };
    act(() => changed({ id: "run-1", snapshot: withTiers }));
    fireEvent.click(screen.getByRole("menuitem", { name: /上下文窗口/ }));
    expect(screen.getByRole("radio", { name: "200K" }).getAttribute("aria-checked")).toBe("true");
    setContextWindow.mockResolvedValueOnce({ ...withTiers, acpOptions: [{ ...withTiers.acpOptions[0], currentValue: "1000000" }] });
    fireEvent.click(screen.getByRole("radio", { name: "1M" }));
    await waitFor(() => expect(setContextWindow).toHaveBeenCalledWith("run-1", "1000000"));
    expect(await screen.findByText("上下文窗口：1M")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /上下文窗口/ }));
    setContextWindow.mockRejectedValueOnce(new Error("档位不可用"));
    fireEvent.click(screen.getByRole("radio", { name: "200K" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "上下文窗口" }).textContent).toContain("档位不可用"));
    expect(screen.getByText("上下文窗口：1M")).toBeTruthy();
  });

  it("shows OpenCode ACP modes and verified external models without Codex permissions", async () => {
    Object.defineProperty(window, "openRouterApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ hasApiKey: true }),
      listModels: vi.fn().mockResolvedValue([{ id: "b", agentVerifications: { opencode: { status: "passed" } } }])
    } });
    setModel.mockResolvedValueOnce({ threadId: "open-1", provider: "opencode", nativeMode: "build", nativeModes: [],
      mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, items: [], approvals: [], acpOptions: [] });
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "open-1", provider: "opencode", nativeMode: "build",
      nativeModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }], mode: "default",
      executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, items: [], approvals: [],
      acpOptions: [{ id: "model", type: "select", currentValue: "opencode/a", options: [
        { value: "opencode/a", name: "Model A" }, { value: "openrouter/b", name: "Model B" }] }],
      capabilities: { history: true, plan: true, attachments: true, permissions: false } } }));
    expect(screen.getByRole("region", { name: "OpenCode 图形会话" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.queryByRole("menuitem", { name: /执行权限/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /模型/ }));
    expect(await screen.findByRole("radio", { name: "Model B" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Model A" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Model B" }));
    await waitFor(() => expect(setModel).toHaveBeenCalledWith("run-1", "openrouter/b"));
  });

  it("keeps verified service models selectable and offers reconnect in an external OpenCode session", async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "openRouterApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ hasApiKey: true }),
      listModels: vi.fn().mockResolvedValue([{ id: "b", agentVerifications: { opencode: { status: "passed" } } }])
    } });
    Object.defineProperty(window, "naraRouterApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ hasApiKey: true }),
      listModels: vi.fn().mockResolvedValue([{ id: "a", agentVerifications: { opencode: { status: "passed" } } }])
    } });
    Object.defineProperty(window, "miniMaxApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ hasApiKey: false }), listModels: vi.fn().mockResolvedValue([])
    } });
    setModel.mockResolvedValueOnce({ threadId: "open-1", provider: "opencode", busy: false, error: null,
      mode: "default", executionPermission: "askApproval", items: [], approvals: [],
      acpOptions: [{ id: "model", type: "select", currentValue: "openrouter/b", options: [
        { value: "nararouter/a", name: "A" }, { value: "openrouter/b", name: "B" }] }] });
    render(<SessionView sessionId="run-1" session={{ id: "run-1", type: "windows", agentProvider: "opencode", modelSource: "nararouter" } as TerminalSession}
      draft="" setDraft={vi.fn()} onReconnectModels={reconnect} />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "open-1", provider: "opencode", busy: false, error: null,
      mode: "default", executionPermission: "askApproval", items: [], approvals: [],
      acpOptions: [{ id: "model", type: "select", currentValue: "nararouter/a", options: [
        { value: "nararouter/a", name: "A" }, { value: "openrouter/b", name: "B" }] }] } }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "重新连接以更新模型" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /^模型 / }));
    fireEvent.click(await screen.findByRole("radio", { name: "B" }));
    await waitFor(() => expect(setModel).toHaveBeenCalledWith("run-1", "openrouter/b"));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重新连接以更新模型" }));
    await waitFor(() => expect(reconnect).toHaveBeenCalledWith("run-1"));
  });
  it("shows only OpenCode-verified external models in local sessions", async () => {
    const serviceApi = (hasApiKey: boolean, models: Array<{ id: string; status: string }>) => ({
      getConfig: vi.fn().mockResolvedValue({ hasApiKey, favoriteModelIds: [] }),
      listModels: vi.fn().mockResolvedValue(models.map(model => ({ id: model.id, agentVerifications: { opencode: { status: model.status } } })))
    });
    Object.defineProperty(window, "openRouterApi", { configurable: true, value: serviceApi(true, [
      { id: "ready", status: "passed" }, { id: "failed", status: "failed" }
    ]) });
    Object.defineProperty(window, "naraRouterApi", { configurable: true, value: serviceApi(false, [{ id: "no-key", status: "passed" }]) });
    Object.defineProperty(window, "miniMaxApi", { configurable: true, value: serviceApi(true, [
      { id: "MiniMax-M2.7", status: "passed" }, { id: "MiniMax-M3", status: "passed" },
      { id: "MiniMax-M2", status: "failed" }, { id: "MiniMax-M1", status: "unavailable" }
    ]) });
    render(<SessionView sessionId="run-1" session={{ id: "run-1", type: "windows", agentProvider: "opencode" } as TerminalSession}
      draft="" setDraft={vi.fn()} />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "open-1", provider: "opencode", busy: false, error: null,
      mode: "default", executionPermission: "askApproval", items: [], approvals: [],
      acpOptions: [{ id: "model", type: "select", currentValue: "opencode/free", options: [
        { value: "opencode/free", name: "Free" }, { value: "other/custom", name: "Custom" },
        { value: "openrouter/ready", name: "Ready" },
        { value: "openrouter/failed", name: "Failed" }, { value: "nararouter/no-key", name: "No key" },
        { value: "minimax/MiniMax-M2.7", name: "MiniMax M2.7" }, { value: "minimax/MiniMax-M3", name: "MiniMax M3" },
        { value: "minimax/MiniMax-M2", name: "MiniMax M2" }, { value: "minimax/MiniMax-M1", name: "MiniMax M1" },
        { value: "minimax-cn/MiniMax-M3", name: "China MiniMax M3" },
        { value: "minimax-cn-coding-plan/MiniMax-M2.7", name: "Coding Plan MiniMax M2.7" }
      ] }] } }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: /^模型 Free$/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /^模型 / }));
    expect(await screen.findByRole("radio", { name: "MiniMax M3" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "MiniMax M2.7" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Ready" })).toBeTruthy();
    for (const name of ["Free", "Custom", "Failed", "No key", "MiniMax M2", "MiniMax M1", "China MiniMax M3", "Coding Plan MiniMax M2.7"])
      expect(screen.queryByRole("radio", { name })).toBeNull();
  });
  it("keeps failed OpenCode model catalogs hidden and retries when the menu reopens", async () => {
    const listModels = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([{ id: "MiniMax-M3", agentVerifications: { opencode: { status: "passed" } } }]);
    Object.defineProperty(window, "openRouterApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ hasApiKey: false }), listModels: vi.fn().mockResolvedValue([])
    } });
    Object.defineProperty(window, "naraRouterApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ hasApiKey: false }), listModels: vi.fn().mockResolvedValue([])
    } });
    Object.defineProperty(window, "miniMaxApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ hasApiKey: true }), listModels
    } });
    render(<SessionView sessionId="run-1" session={{ id: "run-1", type: "wsl", agentProvider: "opencode" } as TerminalSession}
      draft="" setDraft={vi.fn()} />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "open-1", provider: "opencode", busy: false, error: null,
      mode: "default", executionPermission: "askApproval", items: [], approvals: [],
      acpOptions: [{ id: "model", type: "select", currentValue: "opencode/free", options: [
        { value: "opencode/free", name: "Free" }, { value: "minimax/MiniMax-M3", name: "MiniMax M3" }
      ] }] } }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^模型 / }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "模型" }).textContent).toContain("MiniMax 模型读取失败"));
    expect(screen.queryByRole("radio", { name: "MiniMax M3" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Free" })).toBeNull();
    expect(screen.getByText("当前会话没有可选项。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^模型 / }));
    expect(await screen.findByRole("radio", { name: "MiniMax M3" })).toBeTruthy();
    expect(listModels).toHaveBeenCalledTimes(2);
  });
  it("keeps remote OpenCode ACP models visible in SSH sessions", () => {
    render(<SessionView sessionId="run-1" session={{ id: "run-1", type: "ssh", agentProvider: "opencode" } as TerminalSession}
      sessionType="ssh" draft="" setDraft={vi.fn()} />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "open-1", provider: "opencode", busy: false, error: null,
      mode: "default", executionPermission: "askApproval", items: [], approvals: [],
      acpOptions: [{ id: "model", type: "select", currentValue: "opencode/free", options: [
        { value: "opencode/free", name: "Free" }, { value: "minimax/remote", name: "Remote MiniMax" }
      ] }] } }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^模型 / }));
    expect(screen.getByRole("radio", { name: "Free" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Remote MiniMax" })).toBeTruthy();
  });
  it("lists CodeBuddy-verified service models without favorites and switches to the selected model", async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const model = (id: string, status: string) => ({ id, name: id, agentVerifications: { codebuddy: { status } } });
    Object.defineProperty(window, "openRouterApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ hasApiKey: true, favoriteModelIds: [] }),
      listModels: vi.fn().mockResolvedValue([model("vendor/ready", "passed"), model("vendor/blocked", "failed")])
    } });
    Object.defineProperty(window, "naraRouterApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ hasApiKey: false, favoriteModelIds: [] }), listModels: vi.fn().mockResolvedValue([model("vendor/no-key", "passed")])
    } });
    Object.defineProperty(window, "miniMaxApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ hasApiKey: true, favoriteModelIds: [], defaultModelId: "MiniMax-M3" }),
      listModels: vi.fn().mockResolvedValue([model("MiniMax-M2.7", "passed")])
    } });
    render(<SessionView sessionId="run-1" session={{ id: "run-1", type: "windows", agentProvider: "codebuddy", modelSource: "native" } as TerminalSession}
      draft="" setDraft={vi.fn()} onSwitchCodeBuddyModel={switchModel} />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "buddy-1", provider: "codebuddy", busy: false, error: null,
      mode: "default", executionPermission: "askApproval", items: [], approvals: [],
      acpOptions: [{ id: "model", type: "select", currentValue: "hy3", options: [{ value: "hy3", name: "HY3" }] }] } }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^模型 / }));
    expect(await screen.findByRole("radio", { name: /OpenRouter · vendor\/ready/ })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /vendor\/blocked/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /vendor\/no-key/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /原生 · HY3/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /MiniMax · MiniMax-M2\.7/ }));
    await waitFor(() => expect(switchModel).toHaveBeenCalledWith("run-1", "minimax", "MiniMax-M2.7"));
  });
  it("lists only Codex-verified service models and switches to the selected model", async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "openRouterApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ hasApiKey: true, favoriteModelIds: [] }),
      listModels: vi.fn().mockResolvedValue([
        { id: "vendor/ready", name: "Ready", compatible: true, verification: { status: "passed" } },
        { id: "vendor/partial", name: "Partial", compatible: true, verification: { status: "partial" } },
        { id: "vendor/incompatible", name: "Incompatible", compatible: false, verification: { status: "passed" } }
      ])
    } });
    Object.defineProperty(window, "naraRouterApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ hasApiKey: false }),
      listModels: vi.fn().mockResolvedValue([{ id: "vendor/no-key", compatible: true, verification: { status: "passed" } }])
    } });
    Object.defineProperty(window, "miniMaxApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ hasApiKey: true }), listModels: vi.fn().mockResolvedValue([])
    } });
    render(<SessionView sessionId="run-1" session={{ id: "run-1", type: "windows", agentProvider: "codex",
      modelSource: "native", codexBackend: "openai" } as TerminalSession}
      draft="" setDraft={vi.fn()} onSwitchCodexModel={switchModel} />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", provider: "codex", backend: "openai",
      model: "gpt-native", models: [{ id: "gpt-native", displayName: "Native" }], busy: false, error: null,
      mode: "default", executionPermission: "askApproval", items: [], approvals: [] } }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^模型 / }));
    expect(await screen.findByRole("radio", { name: /OpenRouter · Ready/ })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /Partial|Incompatible|no-key/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /OpenAI · Native/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /OpenRouter · Ready/ }));
    await waitFor(() => expect(switchModel).toHaveBeenCalledWith("run-1", "openrouter", "vendor/ready"));
  });
  it("offers the model list in an external CodeBuddy session without ACP model options", async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "openRouterApi", { configurable: true, value: {
      getConfig: vi.fn().mockResolvedValue({ hasApiKey: true, favoriteModelIds: [] }),
      listModels: vi.fn().mockResolvedValue([{ id: "vendor/next", name: "Next", agentVerifications: { codebuddy: { status: "passed" } } }])
    } });
    render(<SessionView sessionId="run-1" session={{ id: "run-1", type: "windows", agentProvider: "codebuddy", modelSource: "openrouter", modelId: "vendor/current" } as TerminalSession}
      draft="" setDraft={vi.fn()} onSwitchCodeBuddyModel={switchModel} />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "buddy-1", provider: "codebuddy", busy: false, error: null,
      mode: "default", executionPermission: "askApproval", items: [], approvals: [], acpOptions: [] } }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^模型 / }));
    expect(screen.getByRole("radio", { name: /原生模型/ })).toBeTruthy();
    fireEvent.click(await screen.findByRole("radio", { name: /OpenRouter · Next/ }));
    await waitFor(() => expect(switchModel).toHaveBeenCalledWith("run-1", "openrouter", "vendor/next"));
  });

  it("follows streamed text near the bottom and preserves the reader's position after scrolling up", async () => {
    const { container } = render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(window.codexAppServerApi.snapshot).toHaveBeenCalledWith("run-1"));
    const messages = container.querySelector<HTMLElement>(".codex-app-server-messages")!;
    let height = 600;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(messages, "clientHeight", { configurable: true, value: 200 });
    const snapshot = (text: string) => ({ threadId: "thread-1", mode: "plan", busy: true,
      error: null, approvals: [], items: [{ id: "plan-1", type: "plan", text }] });

    act(() => changed({ id: "run-1", snapshot: snapshot("# 计划") }));
    expect(messages.scrollTop).toBe(600);

    messages.scrollTop = 80;
    fireEvent.scroll(messages);
    height = 650;
    act(() => changed({ id: "run-1", snapshot: snapshot("# 计划\n第一步") }));
    expect(messages.scrollTop).toBe(80);

    messages.scrollTop = 440;
    fireEvent.scroll(messages);
    height = 700;
    act(() => changed({ id: "run-1", snapshot: snapshot("# 计划\n第一步\n第二步") }));
    expect(messages.scrollTop).toBe(700);

    messages.scrollTop = 120;
    fireEvent.scroll(messages);
    height = 750;
    act(() => changed({ id: "run-1", snapshot: snapshot("# 计划\n第一步\n第二步\n第三步") }));
    expect(messages.scrollTop).toBe(120);
  });

  it("opens background terminals from the Codex menu", async () => {
    listBackgroundTerminals.mockResolvedValueOnce([{ itemId: "item-1", processId: "p-1", command: "pnpm dev",
      cwd: "C:\\project", osPid: null, cpuPercent: null, rssKb: null }]);
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "后台终端" }));
    expect(await screen.findByRole("dialog", { name: "后台终端" })).toBeTruthy();
    expect(await screen.findByText("pnpm dev")).toBeTruthy();
    expect(listBackgroundTerminals).toHaveBeenCalledWith("run-1");
  });

  it("opens history from the input menu and keeps icon actions inside the input", async () => {
    listHistory.mockResolvedValueOnce({ data: [{ id: "old-thread", title: "之前的任务", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: null });
    const { container } = render(<CodexAppServerSession sessionId="run-1" />);
    const composer = container.querySelector(".codex-app-server-composer")!;
    await waitFor(() => expect(screen.getByRole("button", { name: "新对话" })).toHaveProperty("disabled", false));
    expect(container.querySelector(".codex-app-server-toolbar")).toBeNull();
    const inputBorder = container.querySelector(".codex-app-server-input-border")!;
    for (const name of ["更多操作", "新对话", "发送"]) expect(inputBorder.contains(screen.getByRole("button", { name }))).toBe(true);
    expect(composer.querySelector(".codex-app-server-composer-footer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    const menu = screen.getByRole("menu", { name: "会话操作" });
    expect(menu.contains(screen.getByRole("menuitem", { name: /^模式/ }))).toBe(true);
    expect(menu.contains(screen.getByRole("menuitem", { name: /执行权限/ }))).toBe(true);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByRole("menuitem", { name: "附加文件" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "历史会话" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "插件管理" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "后台终端" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "压缩对话" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "代码审查" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "目标管理" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /^模式/ }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /执行权限/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    const dialog = await screen.findByRole("dialog", { name: "历史会话" });
    expect(composer.contains(dialog)).toBe(false);
    expect(await screen.findByText("会话 ID：old-thread")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "历史会话" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.change(screen.getByPlaceholderText("向 Codex 发送消息"), { target: { value: "新对话前的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    await waitFor(() => expect(newThread).toHaveBeenCalledWith("run-1"));
    expect(screen.queryByRole("dialog", { name: "历史会话" })).toBeNull();
    expect((screen.getByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement).value).toBe("");
  });

  it("switches OpenAI models and Fast mode for later turns", async () => {
    const base = { threadId: "thread-1", backend: "openai" as const, mode: "default" as const,
      executionPermission: "askApproval" as const, busy: false, error: null, pendingPlan: null, items: [], approvals: [],
      models: [{ id: "model-a", displayName: "Model A", fastAvailable: true, defaultReasoningEffort: null, supportedReasoningEfforts: [] },
        { id: "model-b", displayName: "Model B", fastAvailable: false, defaultReasoningEffort: null, supportedReasoningEfforts: [] }] };
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({ ...base, model: "model-a", fastMode: false });
    setFastMode.mockResolvedValueOnce({ ...base, model: "model-a", fastMode: true });
    setModel.mockResolvedValueOnce({ ...base, model: "model-b", fastMode: false });
    render(<CodexAppServerSession sessionId="run-1" />);
    expect(await screen.findByText("Model A")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /快速模式/ }));
    fireEvent.click(screen.getByRole("radio", { name: /开启/ }));
    await waitFor(() => expect(setFastMode).toHaveBeenCalledWith("run-1", true));
    expect(await screen.findByText("Model A · 快速")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /模型/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Model B" }));
    await waitFor(() => expect(setModel).toHaveBeenCalledWith("run-1", "model-b"));
    expect(await screen.findByText("Model B")).toBeTruthy();
  });

  it("selects only the current model's reasoning efforts for later turns", async () => {
    const base = { threadId: "thread-1", backend: "openai" as const, mode: "default" as const,
      executionPermission: "askApproval" as const, busy: false, error: null, pendingPlan: null, items: [], approvals: [],
      model: "model-a", models: [{ id: "model-a", displayName: "Model A", fastAvailable: false,
        defaultReasoningEffort: "medium", supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deep" }] }] };
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({ ...base, effort: "medium" });
    setEffort.mockResolvedValueOnce({ ...base, effort: "high" });
    render(<CodexAppServerSession sessionId="run-1" />);
    expect(await screen.findByText("Model A · 中")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /思考强度/ }));
    const group = screen.getByRole("radiogroup", { name: "思考强度" });
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(2);
    fireEvent.click(screen.getByRole("radio", { name: /高/ }));
    await waitFor(() => expect(setEffort).toHaveBeenCalledWith("run-1", "high"));
    expect(await screen.findByText("Model A · 高")).toBeTruthy();
    act(() => changed({ id: "run-1", snapshot: { ...base, effort: "high", busy: true } }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /思考强度/ }));
    expect(screen.getByRole("radio", { name: /中/ })).toHaveProperty("disabled", true);
  });

  it("shows the selected execution permission and disables switching while running", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    expect((await screen.findByText("执行权限：需要确认")).getAttribute("data-permission")).toBe("askApproval");
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /执行权限/ }));
    expect(screen.getByRole("radio", { name: /需要确认/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /完全访问/ }));
    await waitFor(() => expect(setExecutionPermission).toHaveBeenCalledWith("run-1", "fullAccess"));
    expect((await screen.findByText("执行权限：完全访问")).getAttribute("data-permission")).toBe("fullAccess");
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", executionPermission: "fullAccess",
      busy: true, error: null, items: [], approvals: [] } }));
    expect(screen.getByText("执行权限：完全访问")).toBeTruthy();
    expect(screen.queryByText(/Plan 时只读/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /执行权限/ }));
    expect(screen.getByRole("radio", { name: /只读/ })).toHaveProperty("disabled", true);
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", executionPermission: "readOnly",
      busy: false, error: null, items: [], approvals: [] } }));
    expect(screen.getByText("执行权限：只读").getAttribute("data-permission")).toBe("readOnly");
  });

  it("cancels a selection without changing the session and restores focus", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^模式/ }));
    expect(screen.getByRole("radio", { name: "Exec" }).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Exec" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "模式" })).toBeNull();
    expect(setMode).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^模式/ }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "模式" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "模式" })).toBeNull();
    expect(setMode).not.toHaveBeenCalled();
  });

  it("keeps a failed choice open for retry and closes after success", async () => {
    setExecutionPermission.mockRejectedValueOnce(new Error("权限暂不可用"));
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /执行权限/ }));
    fireEvent.click(screen.getByRole("radio", { name: /完全访问/ }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "执行权限" }).textContent).toContain("权限暂不可用"));
    expect(screen.getByRole("radio", { name: /需要确认/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /完全访问/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "执行权限" })).toBeNull());
    expect(setExecutionPermission).toHaveBeenCalledTimes(2);
    expect(screen.getByText("执行权限：完全访问")).toBeTruthy();
  });

  it("routes source links through the parent file navigation handler", async () => {
    const onLinkClick = vi.fn();
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({
      threadId: "thread-1", mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null,
      items: [{ id: "reply", type: "agentMessage", text: "[源码](src/App.tsx:42)" }], approvals: []
    });
    render(<SessionView sessionId="run-1" draft="" setDraft={() => {}} onLinkClick={onLinkClick} />);
    fireEvent.click(await screen.findByRole("link", { name: "源码" }));
    await waitFor(() => expect(onLinkClick).toHaveBeenCalledWith("src/App.tsx:42"));
  });

  it("shows CodeBuddy native Plan as the selected mode", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "buddy-1", provider: "codebuddy",
      nativeMode: "plan", nativeModes: [{ id: "default", name: "Standard" }, { id: "plan", name: "Plan" }],
      mode: "plan", executionPermission: "askApproval", busy: false,
      error: null, pendingPlan: null, items: [], approvals: [] } }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^模式/ }));
    expect(screen.getByRole("radio", { name: /Plan/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(/只读未生效/)).toBeNull();
  });

  it("shows conversation content without user or Codex role labels", async () => {
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({
      threadId: "thread-1", mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null,
      items: [
        { id: "user", type: "userMessage", text: "检查项目" },
        { id: "agent", type: "agentMessage", text: "开始检查" },
        { id: "command", type: "commandExecution", command: "pwd", status: "completed" },
        { id: "progress", type: "agentMessage", text: "继续检查" },
        { id: "command-2", type: "commandExecution", command: "dir", status: "completed" },
        { id: "plan", type: "plan", text: "执行步骤" }
      ], approvals: []
    });
    const { container } = render(<CodexAppServerSession sessionId="run-1" />);
    expect(await screen.findByText("继续检查")).toBeTruthy();
    expect(container.querySelector(".codex-app-server-message.user-message")?.textContent).toBe("检查项目");
    expect(container.querySelector(".codex-app-server-message.agent-message")?.textContent).toBe("开始检查");
    expect(Array.from(container.querySelectorAll(".codex-app-server-message.agent-message")).map(node => node.textContent))
      .toEqual(["开始检查", "继续检查"]);
    expect(container.querySelector(".codex-app-server-message.plan > strong")?.textContent).toBe("计划");
  });

  it("searches titles and IDs across history pages", async () => {
    listHistory.mockImplementation(async (_id, cursor) => cursor === "next"
      ? { data: [{ id: "second-id", title: "部署记录", updatedAt: 122, source: "cli", status: "notLoaded" }], nextCursor: null }
      : { data: [{ id: "first-id", title: "之前的任务", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: "next" });
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    await screen.findByText("会话 ID：first-id");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索历史会话" }), { target: { value: "SECOND-ID" } });
    expect(await screen.findByText("会话 ID：second-id")).toBeTruthy();
    expect(screen.queryByText("会话 ID：first-id")).toBeNull();
    expect(listHistory).toHaveBeenCalledWith("run-1", "next", false);
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索历史会话" }), { target: { value: "之前" } });
    expect(await screen.findByText("会话 ID：first-id")).toBeTruthy();
    expect(screen.queryByText("会话 ID：second-id")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索历史会话" }), { target: { value: "missing" } });
    expect(await screen.findByText("没有匹配的历史会话。")).toBeTruthy();
  });

  it("keeps the history dialog open and shows errors when listing or resuming fails", async () => {
    listHistory.mockRejectedValueOnce(new Error("读取失败"));
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "读取失败");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索历史会话" }), { target: { value: "old" } });
    listHistory.mockResolvedValueOnce({ data: [{ id: "old-thread", title: "旧会话", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: null });
    const item = await screen.findByRole("button", { name: /旧会话/ });
    resume.mockRejectedValueOnce(new Error("恢复失败"));
    fireEvent.click(item);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "恢复失败");
    expect(screen.getByRole("dialog", { name: "历史会话" })).toBeTruthy();
  });

  it("ends a stalled history load and retries without accepting its late result", async () => {
    let finishStalled: (value: { data: any[]; nextCursor: null }) => void = () => {};
    listHistory.mockImplementationOnce(() => new Promise(resolve => { finishStalled = resolve; }));
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    const originalSetTimeout = window.setTimeout.bind(window);
    const timeoutSpy = vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: any[]) =>
      originalSetTimeout(handler, timeout === 35000 ? 0 : timeout, ...args)) as typeof window.setTimeout);
    try {
      fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
      expect(await screen.findByRole("alert")).toHaveProperty("textContent", "加载历史会话超时，请重试。");
      expect(screen.queryByText("正在加载历史会话…")).toBeNull();
      listHistory.mockResolvedValueOnce({ data: [{ id: "retry-thread", title: "重试成功", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: null });
      fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
      expect(await screen.findByText("会话 ID：retry-thread")).toBeTruthy();
      await act(async () => finishStalled({ data: [{ id: "stale-thread", title: "旧结果", updatedAt: 122, source: "cli" }], nextCursor: null }));
      expect(screen.queryByText("会话 ID：stale-thread")).toBeNull();
    } finally { timeoutSpy.mockRestore(); }
  });

  it("explains a slow history request and clears the message after loading", async () => {
    let finishLoading: (value: { data: any[]; nextCursor: null }) => void = () => {};
    listHistory.mockImplementationOnce(() => new Promise(resolve => { finishLoading = resolve; }));
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    const originalSetTimeout = window.setTimeout.bind(window);
    const timeoutSpy = vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: any[]) =>
      originalSetTimeout(handler, timeout === 4000 ? 0 : timeout, ...args)) as typeof window.setTimeout);
    try {
      fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
      expect(await screen.findByRole("status")).toHaveProperty("textContent", "检索较慢，仍在读取历史会话…");
      await act(async () => finishLoading({ data: [{ id: "game4-thread", title: "game4 历史", updatedAt: 123, source: "cli" }], nextCursor: null }));
      expect(await screen.findByText("会话 ID：game4-thread")).toBeTruthy();
      expect(screen.queryByText("检索较慢，仍在读取历史会话…")).toBeNull();
    } finally { timeoutSpy.mockRestore(); }
  });

  it("offers Codex thread actions, lists archived threads, and switches to a fork", async () => {
    listHistory.mockImplementation(async (_id, _cursor, archived) => ({ data: archived
      ? [{ id: "archived-1", title: "归档任务", updatedAt: 122, source: "cli", status: "notLoaded", archived: true }]
      : [{ id: "old-1", title: "旧任务", updatedAt: 123, source: "cli", status: "notLoaded", isPinned: false }], nextCursor: null }));
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    await screen.findByText("会话 ID：old-1");
    fireEvent.click(screen.getByRole("button", { name: "置顶" }));
    await waitFor(() => expect(pinThread).toHaveBeenCalledWith("run-1", "old-1", true));
    fireEvent.click(screen.getByRole("tab", { name: "已归档" }));
    await screen.findByText("会话 ID：archived-1");
    fireEvent.click(screen.getByRole("button", { name: "恢复归档" }));
    await waitFor(() => expect(unarchiveThread).toHaveBeenCalledWith("run-1", "archived-1"));
    fireEvent.click(screen.getByRole("tab", { name: "进行中" }));
    await screen.findByText("会话 ID：old-1");
    fireEvent.click(screen.getByRole("button", { name: "分叉" }));
    await waitFor(() => expect(forkThread).toHaveBeenCalledWith("run-1", "old-1"));
    expect(screen.queryByRole("dialog", { name: "历史会话" })).toBeNull();
  });

  it("updates pin state and order immediately, then reads the persisted state when reopened", async () => {
    let pinned = false;
    listHistory.mockImplementation(async () => ({ data: [
      { id: "recent", title: "较新会话", updatedAt: 200, source: "cli", status: "notLoaded", isPinned: false },
      { id: "older", title: "较早会话", updatedAt: 100, source: "cli", status: "notLoaded", isPinned: pinned }
    ], nextCursor: null }));
    pinThread.mockImplementation(async (_id, _threadId, isPinned) => { pinned = isPinned; return { isPinned }; });
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    await screen.findByText("会话 ID：older");
    const titles = () => Array.from(document.querySelectorAll(".codex-app-server-history-select strong"), item => item.textContent);
    expect(titles()).toEqual(["较新会话", "较早会话"]);
    fireEvent.click(screen.getAllByRole("button", { name: "置顶" }).at(-1)!);
    await waitFor(() => expect(titles()).toEqual(["较早会话", "较新会话"]));
    expect(screen.getByRole("button", { name: "取消置顶" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消置顶" }));
    await waitFor(() => expect(titles()).toEqual(["较新会话", "较早会话"]));
    fireEvent.click(screen.getAllByRole("button", { name: "置顶" }).at(-1)!);
    await waitFor(() => expect(titles()).toEqual(["较早会话", "较新会话"]));
    fireEvent.click(screen.getByRole("button", { name: "关闭历史会话" }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    await waitFor(() => expect(titles()).toEqual(["较早会话", "较新会话"]));
    expect(listHistory).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous pin state and shows the request error", async () => {
    listHistory.mockResolvedValue({ data: [{ id: "old-1", title: "旧任务", updatedAt: 123,
      source: "cli", status: "notLoaded", isPinned: false }], nextCursor: null });
    pinThread.mockRejectedValueOnce(new Error("置顶状态未确认"));
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    await screen.findByText("会话 ID：old-1");
    fireEvent.click(screen.getByRole("button", { name: "置顶" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "置顶状态未确认");
    expect(screen.getByRole("button", { name: "置顶" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取消置顶" })).toBeNull();
  });

  it("keeps the current archived thread visible but prevents sending", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", archived: true, mode: "default",
      executionPermission: "askApproval", busy: false, error: null, items: [{ id: "answer-1", type: "agentMessage", text: "已有回复" }], approvals: [] } }));
    expect(screen.getByText("已有回复")).toBeTruthy();
    expect(screen.queryByText("已归档 · 只读")).toBeNull();
    expect(screen.getByPlaceholderText("此会话已归档，请先恢复归档")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "发送" })).toHaveProperty("disabled", true);
  });

  it("answers multiple App Server questions with choices and free text", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: true, error: null, items: [], approvals: [],
      questions: [{ requestId: 42, submitting: false, params: { threadId: "thread-1", turnId: "turn-1", questions: [
        { id: "framework", header: "框架", question: "选择框架", isOther: true,
          options: [{ label: "React", description: "使用 React" }, { label: "Vue", description: "使用 Vue" }] },
        { id: "details", header: "细节", question: "请补充", options: null }
      ] } }] } }));
    expect(screen.getByText("选择框架")).toBeTruthy();
    expect(screen.queryByText("请补充")).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    expect(screen.getByRole("alert").textContent).toContain("请回答");
    fireEvent.click(screen.getByRole("radio", { name: /React/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "补充说明或自定义回答" }), { target: { value: "继续" } });
    expect(screen.getByRole("tab", { name: /框架.*已回答/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /细节.*待回答/ }));
    expect(screen.getByText("请补充")).toBeTruthy();
    expect(screen.queryByText("选择框架")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "回答" }), { target: { value: "保持简单" } });
    fireEvent.click(screen.getByRole("tab", { name: /框架.*已回答/ }));
    expect(screen.getByRole("radio", { name: /React/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("textbox", { name: "补充说明或自定义回答" })).toHaveProperty("value", "继续");
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith("run-1", 42, {
      framework: { answers: ["React", "user_note: 继续"] }, details: { answers: ["user_note: 保持简单"] }
    }));
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: true, error: null, approvals: [], questions: [],
      items: [{ id: "question-answer:turn-1:42", type: "questionAnswer", turnId: "turn-1", status: "completed", questions: [
        { id: "framework", header: "框架", question: "选择框架", answers: ["React", "user_note: 继续"] },
        { id: "details", header: "细节", question: "请补充", answers: ["user_note: 保持简单"] }
      ] }] } }));
    expect(screen.queryByRole("button", { name: "提交回答" })).toBeNull();
    expect(screen.getByRole("article", { name: "已回答的 Codex 提问" }).textContent).toContain("选择框架");
    expect(screen.getByRole("article", { name: "已回答的 Codex 提问" }).textContent).toContain("补充说明：保持简单");
  });

  it("shows CodeBuddy questions as answer cards without an approval step", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", provider: "codebuddy", mode: "plan",
      busy: true, error: null, items: [], approvals: [], questions: [{ requestId: 92, submitting: false,
        params: { threadId: "thread-1", turnId: "turn-1", questions: [{ id: "q_0", header: "方案",
          question: "选择方案", isOther: true, options: [{ label: "A", description: "" }] }] } }] } }));
    expect(screen.getByRole("article", { name: "CodeBuddy 提问" })).toBeTruthy();
    expect(screen.queryByText("操作确认")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "自定义回答" }), { target: { value: "采用 B" } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith("run-1", 92, { q_0: { answers: ["采用 B"] } }));
  });

  it("answers and cancels OpenCode questions through the graphical card", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", provider: "opencode", mode: "default",
      busy: true, error: null, items: [], approvals: [], questions: [{ requestId: "question-1", submitting: false,
        params: { threadId: "thread-1", turnId: "turn-1", questions: [{ id: "plan", header: "方案",
          question: "选择方案", isOther: true, options: [{ label: "甲", description: "" }] }] } }] } }));
    expect(screen.getByRole("article", { name: "OpenCode 提问" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "补充说明或自定义回答" }), { target: { value: "乙" } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith("run-1", "question-1", { plan: { answers: ["乙"], customAnswer: "乙" } }));
    fireEvent.click(screen.getByRole("button", { name: "取消提问" }));
    await waitFor(() => expect(cancelQuestion).toHaveBeenCalledWith("run-1", "question-1"));
  });

  it("switches to the first unanswered question before submission", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: true, error: null, items: [], approvals: [],
      questions: [{ requestId: 44, submitting: false, params: { threadId: "thread-1", turnId: "turn-1", questions: [
        { id: "first", header: "第一题", question: "选择方案", options: [{ label: "方案 A", description: "描述" }] },
        { id: "second", header: "第二题", question: "补充细节", options: null }
      ] } }] } }));
    fireEvent.click(screen.getByRole("tab", { name: /第二题.*待回答/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "回答" }), { target: { value: "细节" } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    expect(screen.getByRole("tab", { name: /第一题.*待回答/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("第一题");
    expect(answerQuestion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: /方案 A/ }));
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith("run-1", 44, {
      first: { answers: ["方案 A"] }, second: { answers: ["user_note: 细节"] }
    }));
  });

  it("keeps the Question available after a failed answer", async () => {
    answerQuestion.mockRejectedValueOnce(new Error("发送失败"));
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: true, error: null, items: [], approvals: [],
      questions: [{ requestId: 43, submitting: false, params: { threadId: "thread-1", turnId: "turn-1", questions: [
        { id: "answer", header: "答案", question: "请输入答案", options: null },
        { id: "reason", header: "理由", question: "请输入理由", options: null }
      ] } }] } }));
    fireEvent.change(screen.getByRole("textbox", { name: "回答" }), { target: { value: "继续" } });
    fireEvent.click(screen.getByRole("tab", { name: /理由.*待回答/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "回答" }), { target: { value: "保持简单" } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "发送失败");
    fireEvent.click(screen.getByRole("tab", { name: /答案.*已回答/ }));
    expect(screen.getByRole("textbox", { name: "回答" })).toHaveProperty("value", "继续");
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledTimes(2));
    expect(answerQuestion).toHaveBeenLastCalledWith("run-1", 43, {
      answer: { answers: ["user_note: 继续"] }, reason: { answers: ["user_note: 保持简单"] }
    });
  });

  it("sends messages and displays a command approval", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "检查项目" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "检查项目", [], []));
    expect(input.value).toBe("");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [],
      approvals: [{ requestId: 9, method: "item/commandExecution/requestApproval", params: { command: "pnpm test", cwd: "C:\\repo" } }] } });
    expect(await screen.findByText("pnpm test")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "批准一次" }));
    await waitFor(() => expect(resolveApproval).toHaveBeenCalledWith("run-1", 9, "accept"));
  });

  it("offers only allowed Codex command decisions and shows the proposed rule", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [],
      approvals: [{ requestId: 91, method: "item/commandExecution/requestApproval", params: {
        command: "pnpm test", proposedExecpolicyAmendment: ["pnpm", "test"],
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel", "acceptWithExecpolicyAmendment"] } }] } }));
    expect(await screen.findByText('["pnpm","test"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消并停止本回合" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "本会话允许" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "本会话允许" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "批准并应用命令规则" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "批准并应用命令规则" }));
    await waitFor(() => expect(resolveApproval).toHaveBeenCalledWith("run-1", 91, "cancel"));
    expect(resolveApproval).toHaveBeenCalledWith("run-1", 91, "acceptForSession");
    expect(resolveApproval).toHaveBeenCalledWith("run-1", 91, "acceptWithExecpolicyAmendment");
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [],
      approvals: [{ requestId: 92, method: "item/commandExecution/requestApproval", params: {
        networkApprovalContext: { host: "example.com", protocol: "https", port: 443 }, availableDecisions: ["decline", "cancel"] } }] } }));
    expect(await screen.findByText("https://example.com:443")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "批准一次" })).toBeNull();
    expect(screen.queryByRole("button", { name: "本会话允许" })).toBeNull();
    expect(screen.queryByRole("button", { name: "批准并应用命令规则" })).toBeNull();
  });

  it("offers file decisions and explicit turn or session permission grants", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [],
      approvals: [{ requestId: 93, method: "item/fileChange/requestApproval", params: { grantRoot: "C:\\repo" } }] } }));
    expect(await screen.findByText("授权目录：C:\\repo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消并停止本回合" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "本会话允许" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "批准并应用命令规则" })).toBeNull();
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [],
      approvals: [{ requestId: 94, method: "item/permissions/requestApproval", params: {
        permissions: { network: { enabled: true } } } }] } }));
    fireEvent.click(screen.getByRole("button", { name: "本回合允许" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "本会话允许" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "本会话允许" }));
    expect(resolveApproval).toHaveBeenCalledWith("run-1", 94, "accept");
    expect(resolveApproval).toHaveBeenCalledWith("run-1", 94, "acceptForSession");
    expect(screen.queryByRole("button", { name: "取消并停止本回合" })).toBeNull();
  });

  it.each(["form", "openai/form"] as const)("renders %s MCP tool approval without a JSON input", async mode => {
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [], approvals: [],
      elicitations: [{ requestId: 71, submitting: false, params: { threadId: "thread-1", serverName: "pannel_handle_remote", mode,
        message: 'Allow the pannel_handle_remote MCP server to run tool "remote_exec"?', requestedSchema: { type: "object", properties: {}, required: [] } } }] } }));
    expect(screen.getByText(/MCP 工具调用授权/)).toBeTruthy();
    expect(screen.getByText("是否允许 pannel_handle_remote 调用工具 remote_exec？")).toBeTruthy();
    expect(screen.queryByLabelText("JSON 表单内容")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    await waitFor(() => expect(resolveElicitation).toHaveBeenCalledWith("run-1", 71, "accept", {}));
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(resolveElicitation).toHaveBeenCalledWith("run-1", 71, "decline", null));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(resolveElicitation).toHaveBeenCalledWith("run-1", 71, "cancel", null));
  });

  it("keeps generic empty MCP forms as JSON forms", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [], approvals: [],
      elicitations: [{ requestId: 71, submitting: false, params: { threadId: "thread-1", serverName: "calendar", mode: "form",
        message: "Provide details", requestedSchema: { type: "object" } } }] } }));
    expect(screen.getByLabelText("JSON 表单内容")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() => expect(resolveElicitation).toHaveBeenCalledWith("run-1", 71, "accept", {}));
  });

  it("submits MCP form fields only after required values are entered", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [], approvals: [],
      elicitations: [{ requestId: 71, submitting: false, params: { threadId: "thread-1", serverName: "calendar", mode: "form",
        message: "Choose calendar", requestedSchema: { type: "object", required: ["calendar"],
          properties: { calendar: { type: "string", title: "日历" }, privateNote: { type: "string", format: "password" } } } } }] } }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(screen.getByRole("alert").textContent).toContain("日历");
    expect(resolveElicitation).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("日历 *"), { target: { value: "Team" } });
    fireEvent.change(screen.getByLabelText("privateNote"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() => expect(resolveElicitation).toHaveBeenCalledWith("run-1", 71, "accept", { calendar: "Team", privateNote: "secret" }));
    expect((screen.getByLabelText("privateNote") as HTMLInputElement).type).toBe("password");
  });

  it("opens MCP URL externally and waits for an explicit completion decision", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [], approvals: [],
      elicitations: [{ requestId: 72, submitting: false, params: { threadId: "thread-1", serverName: "calendar", mode: "url",
        message: "Authorize calendar", url: "https://example.com/authorize" } }] } }));
    expect((screen.getByRole("button", { name: "已完成" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "打开链接" }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://example.com/authorize"));
    expect(resolveElicitation).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getByRole("button", { name: "已完成" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "已完成" }));
    await waitFor(() => expect(resolveElicitation).toHaveBeenCalledWith("run-1", 72, "accept", null));
  });

  it("keeps MCP URL completion unavailable when opening the browser fails", async () => {
    openExternal.mockRejectedValueOnce(new Error("外部浏览器不可用"));
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [], approvals: [],
      elicitations: [{ requestId: 73, submitting: false, params: { threadId: "thread-1", serverName: "calendar", mode: "url",
        message: "Authorize calendar", url: "https://example.com/authorize" } }] } }));
    fireEvent.click(screen.getByRole("button", { name: "打开链接" }));
    expect((await screen.findByRole("alert")).textContent).toContain("外部浏览器不可用");
    expect((screen.getByRole("button", { name: "已完成" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(resolveElicitation).toHaveBeenCalledWith("run-1", 73, "cancel", null));
  });

  it("sends a message with an attachment while Codex is running and keeps Stop available", async () => {
    chooseFiles.mockResolvedValueOnce(["C:\\project\\notes.txt"]);
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true,
      error: null, items: [], approvals: [] } }));
    expect(input.disabled).toBe(false);
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "附加文件" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("menuitem", { name: "附加文件" }));
    await waitFor(() => expect(screen.getByText("notes.txt")).toBeTruthy());
    fireEvent.change(input, { target: { value: "补充要求" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "补充要求", ["C:\\project\\notes.txt"], []));
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
  });

  it("allows editing for CodeBuddy side questions while blocking normal in-flight messages", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "buddy-1", provider: "codebuddy", mode: "default",
      executionPermission: "askApproval", busy: true, error: null, items: [], approvals: [] } }));
    const input = screen.getByPlaceholderText("向 CodeBuddy 发送消息");
    expect(input).toHaveProperty("disabled", false);
    fireEvent.change(input, { target: { value: "普通草稿" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submit).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "旁问" }));
    expect(screen.getByRole("dialog", { name: "CodeBuddy 旁问" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭旁问" }));
    expect(input).toHaveProperty("value", "普通草稿");
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
  });

  it("routes /btw with a question separately and does not match /btwxxx", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "buddy-1", provider: "codebuddy", mode: "default",
      executionPermission: "askApproval", busy: true, error: null, items: [], approvals: [] } }));
    const askSideQuestion = vi.fn().mockResolvedValue({ threadId: "buddy-1", sideQuestion: null });
    window.codexAppServerApi.askSideQuestion = askSideQuestion;
    const input = screen.getByPlaceholderText("向 CodeBuddy 发送消息");
    fireEvent.change(input, { target: { value: "/btwxxx 问题" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "CodeBuddy 旁问" })).toBeNull();
    expect(askSideQuestion).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "/btw 目前进展？" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(askSideQuestion).toHaveBeenCalledWith("run-1", "目前进展？"));
    expect(submit).not.toHaveBeenCalled();
    expect(input).toHaveProperty("value", "");
  });

  it("keeps other ACP providers disabled while busy", () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "open-1", provider: "opencode", mode: "default",
      executionPermission: "askApproval", busy: true, error: null, items: [], approvals: [] } }));
    expect(screen.getByPlaceholderText("向 OpenCode 发送消息")).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "旁问" })).toBeNull();
  });

  it("restores a rejected in-flight message and its attachment", async () => {
    submit.mockRejectedValueOnce(new Error("turn/steer rejected"));
    chooseFiles.mockResolvedValueOnce(["C:\\project\\notes.txt"]);
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true,
      error: null, items: [], approvals: [] } }));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "附加文件" }));
    await waitFor(() => expect(screen.getByText("notes.txt")).toBeTruthy());
    fireEvent.change(input, { target: { value: "补充要求" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveProperty("textContent", "turn/steer rejected"));
    expect(input.value).toBe("补充要求");
    expect(screen.getByText("notes.txt")).toBeTruthy();
  });

  it("animates the input border only while running in either mode", async () => {
    const { container } = render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByPlaceholderText("向 Codex 发送消息")).toHaveProperty("disabled", false));
    const inputBorder = container.querySelector(".codex-app-server-input-border")!;
    expect(inputBorder.classList.contains("is-running")).toBe(false);
    expect((inputBorder as HTMLElement).dataset.mode).toBe("default");

    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [], approvals: [] } });
    await waitFor(() => expect(inputBorder.classList.contains("is-running")).toBe(true));
    expect((inputBorder as HTMLElement).dataset.mode).toBe("default");

    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: true, error: null, items: [], approvals: [] } });
    await waitFor(() => expect((inputBorder as HTMLElement).dataset.mode).toBe("plan"));
    expect(inputBorder.classList.contains("is-running")).toBe(true);
    expect(screen.queryByText("Codex 正在运行…")).toBeNull();
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();

    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: false, error: null, items: [], approvals: [] } });
    await waitFor(() => expect(inputBorder.classList.contains("is-running")).toBe(false));
    expect((inputBorder as HTMLElement).dataset.mode).toBe("plan");

    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false, error: null, items: [], approvals: [] } });
    await waitFor(() => expect((inputBorder as HTMLElement).dataset.mode).toBe("default"));
    expect(inputBorder.classList.contains("is-running")).toBe(false);
  });

  it("keeps each App Server draft when switching sessions and visiting a terminal session", async () => {
    const { rerender } = render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "第一会话草稿" } });

    rerender(<CodexAppServerSession sessionId="run-2" />);
    expect((screen.getByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByPlaceholderText("向 Codex 发送消息"), { target: { value: "第二会话草稿" } });

    rerender(<CodexAppServerSession sessionId={null} />);
    expect(screen.queryByPlaceholderText("向 Codex 发送消息")).toBeNull();
    rerender(<CodexAppServerSession sessionId="run-1" />);
    expect((screen.getByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement).value).toBe("第一会话草稿");
    rerender(<CodexAppServerSession sessionId="run-2" />);
    expect((screen.getByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement).value).toBe("第二会话草稿");
  });

  it("restores a failed send to its original session after switching away", async () => {
    let rejectSend: (reason: Error) => void = () => {};
    submit.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    const { rerender } = render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "发送失败后保留" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "发送失败后保留", [], []));

    rerender(<CodexAppServerSession sessionId="run-2" />);
    fireEvent.change(screen.getByPlaceholderText("向 Codex 发送消息"), { target: { value: "第二会话内容" } });
    await act(async () => rejectSend(new Error("发送失败")));
    expect((screen.getByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement).value).toBe("第二会话内容");

    rerender(<CodexAppServerSession sessionId="run-1" />);
    expect((screen.getByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement).value).toBe("发送失败后保留");
  });

  it("fills the draft or sends an App Server quick command according to its mode", async () => {
    const ref = createRef<CodexAppServerSessionHandle>();
    render(<CodexAppServerSession sessionId="run-1" ref={ref} />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "已有内容 " } });
    await act(async () => { expect(await ref.current?.applyQuickCommand({ id: "write", command: "继续", mode: "write" })).toBe(true); });
    expect(input.value).toBe("已有内容 继续");
    await act(async () => { expect(await ref.current?.applyQuickCommand({ id: "send", command: "立即检查", mode: "auto-enter" })).toBe(true); });
    expect(submit).toHaveBeenCalledWith("run-1", "立即检查", []);
    expect(input.value).toBe("已有内容 继续");
  });

  it("appends file paths to the graphical draft without submitting it", async () => {
    const ref = createRef<CodexAppServerSessionHandle>();
    render(<CodexAppServerSession sessionId="run-1" ref={ref} />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "检查这个文件" } });

    act(() => {
      ref.current?.appendFilePath("C:\\work space\\a.ts");
      ref.current?.appendFilePath("C:\\work space\\b.ts");
    });

    expect(input.value).toBe("检查这个文件 C:\\work space\\a.ts C:\\work space\\b.ts");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(submit).not.toHaveBeenCalled();
  });

  it("renders plan Markdown and keeps newly arrived tool details collapsed", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: false, error: null, approvals: [], items: [
      { id: "plan-1", type: "plan", text: "# 正式计划\n\n- 检查代码" },
      { id: "cmd-1", type: "commandExecution", command: "pnpm build", output: "构建成功", status: "completed" }
    ] } });
    expect(await screen.findByRole("heading", { name: "正式计划" })).toBeTruthy();
    expect(screen.getByText("检查代码")).toBeTruthy();
    const summary = screen.getByRole("button", { name: /工具调用 · 1 项/ });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(summary.textContent).toContain("已完成");
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("pnpm build")).toBeTruthy();
    const command = screen.getByRole("button", { name: /执行命令.*pnpm build/ });
    expect(command.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("构建成功")).toBeNull();
    fireEvent.click(command);
    expect(screen.getByText("构建成功")).toBeTruthy();
  });

  it("shows concise CodeBuddy tool summaries and keeps full titles in details", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    const command = "`cd /c/mine/crm/personal/pannel_handle && git diff electron/services/codebuddy-acp/session-service.cjs`";
    changed({ id: "run-1", snapshot: { threadId: "thread-1", provider: "codebuddy", mode: "default", busy: false,
      error: null, approvals: [], items: [
        { id: "read-1", type: "toolCall", toolKind: "read", toolName: "Read C:\\work\\session-service.cjs (2 - 71)", status: "completed" },
        { id: "run-1", type: "toolCall", toolKind: "execute", toolName: command, output: "Show diffs of the two test files", status: "completed" },
        { id: "run-2", type: "toolCall", toolKind: "execute", toolName: "grep -n important src", output: "first line\nsecond line", status: "completed" },
        { id: "run-3", type: "toolCall", toolKind: "execute", toolName: "node -e run", output: "x".repeat(81), status: "completed" }
      ] } });
    fireEvent.click(await screen.findByRole("button", { name: /工具调用 · 4 项/ }));
    const read = screen.getByRole("button", { name: /读取文件.*session-service.cjs/ });
    const run = screen.getByRole("button", { name: /执行命令.*Show diffs of the two test files/ });
    const [multiline, longOutput] = screen.getAllByRole("button", { name: /^执行命令.*已完成$/ });
    expect(read.textContent).not.toContain("C:\\work");
    expect(run.textContent).not.toContain(command);
    expect(multiline.textContent).not.toContain("first line");
    expect(longOutput.textContent).not.toContain("x".repeat(81));
    fireEvent.click(run);
    expect(screen.getByText(command)).toBeTruthy();
    expect(screen.getAllByText("Show diffs of the two test files")).toHaveLength(2);
  });

  it("groups adjacent tool calls and keeps the group open during output updates", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    const first = { id: "cmd-1", type: "commandExecution", command: "pnpm build", output: "构建成功", status: "completed" };
    const second = { id: "cmd-2", type: "commandExecution", command: "pnpm test", output: "正在测试", status: "inProgress" };
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, approvals: [], items: [first, second] } });
    const summary = await screen.findByRole("button", { name: /工具调用 · 2 项/ });
    expect(document.querySelectorAll(".codex-app-server-event")).toHaveLength(1);
    expect(summary.textContent).toContain("进行中");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(summary);
    expect(screen.getByText("pnpm build")).toBeTruthy();
    expect(screen.getByText("pnpm test")).toBeTruthy();
    const firstCommand = screen.getByRole("button", { name: /执行命令.*pnpm build/ });
    const secondCommand = screen.getByRole("button", { name: /执行命令.*pnpm test/ });
    expect(firstCommand.getAttribute("aria-expanded")).toBe("false");
    expect(secondCommand.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("构建成功")).toBeNull();
    fireEvent.click(firstCommand);
    expect(screen.getByText("构建成功")).toBeTruthy();

    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false, error: null, approvals: [], items: [
      first, { ...second, output: "测试完成", status: "completed" }
    ] } });
    expect(screen.queryByText("测试完成")).toBeNull();
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(summary.textContent).toContain("已完成"));
    expect(firstCommand.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(secondCommand);
    expect(screen.getByText("测试完成")).toBeTruthy();
  });

  it("starts a new tool group for the next turn", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false, error: null, approvals: [], items: [
      { id: "cmd-1", turnId: "turn-1", type: "commandExecution", command: "pwd", status: "completed" },
      { id: "cmd-2", turnId: "turn-1", type: "commandExecution", command: "dir", status: "failed" },
      { id: "msg-1", turnId: "turn-1", type: "agentMessage", text: "检查结果" },
      { id: "cmd-3", turnId: "turn-2", type: "commandExecution", command: "pnpm test", status: "completed" }
    ] } });
    const summaries = await screen.findAllByText(/工具调用 · [12] 项/);
    expect(summaries).toHaveLength(2);
    expect(summaries[0].closest("button")?.textContent).toContain("有失败");
    expect(summaries[1].closest("button")?.textContent).toContain("已完成");
    expect(document.querySelectorAll(".codex-app-server-event")).toHaveLength(2);
  });

  it("starts a new tool group after each Codex reply in the same turn", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    const firstCalls = Array.from({ length: 4 }, (_, index) => ({
      id: `cmd-a-${index}`, turnId: "turn-1", type: "commandExecution", command: `a-${index}`, status: "completed"
    }));
    const secondCalls = Array.from({ length: 5 }, (_, index) => ({
      id: `cmd-b-${index}`, turnId: "turn-1", type: "commandExecution", command: `b-${index}`, status: "completed"
    }));
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, approvals: [], items: [
      { id: "msg-a", turnId: "turn-1", type: "agentMessage", text: "回复 A" },
      ...firstCalls, { id: "reasoning-1", turnId: "turn-1", type: "reasoning" },
      { id: "msg-b", turnId: "turn-1", type: "agentMessage", text: "回复 B" }, ...secondCalls
    ] } });
    const firstSummary = await screen.findByRole("button", { name: /工具调用 · 4 项/ });
    const secondSummary = screen.getByRole("button", { name: /工具调用 · 5 项/ });
    expect(Array.from(document.querySelectorAll(".codex-app-server-messages > article, .codex-app-server-messages > section"))
      .slice(0, 5).map(node => node.textContent)).toEqual([
        expect.stringContaining("回复 A"), expect.stringContaining("工具调用 · 4 项"),
        expect.stringContaining("回复 B"), expect.stringContaining("工具调用 · 5 项")
      ]);
    expect(screen.queryByText("a-0")).toBeNull();
    expect(screen.queryByText("b-0")).toBeNull();
    fireEvent.click(firstSummary);
    expect(Array.from(firstSummary.closest(".codex-app-server-event")!.querySelectorAll(".codex-app-server-tool-heading"))
      .map(node => node.getAttribute("aria-expanded"))).toEqual(["false", "false", "false", "false"]);
    expect(firstSummary.closest(".codex-app-server-event")!.querySelectorAll(".codex-app-server-tool pre")).toHaveLength(0);
    expect(screen.queryByText("b-0")).toBeNull();
    fireEvent.click(secondSummary);
    expect(Array.from(secondSummary.closest(".codex-app-server-event")!.querySelectorAll(".codex-app-server-tool-heading")))
      .toHaveLength(5);
    fireEvent.click(secondSummary.closest(".codex-app-server-event")!.querySelector(".codex-app-server-tool-heading")!);
    expect(Array.from(secondSummary.closest(".codex-app-server-event")!.querySelectorAll(".codex-app-server-tool pre"))
      .map(node => node.textContent)).toEqual(["b-0"]);
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false, error: null, approvals: [], items: [
      { id: "msg-a", turnId: "turn-1", type: "agentMessage", text: "回复 A" },
      ...firstCalls, { id: "reasoning-1", turnId: "turn-1", type: "reasoning" },
      { id: "msg-b", turnId: "turn-1", type: "agentMessage", text: "回复 B" },
      ...secondCalls.slice(0, -1), { ...secondCalls.at(-1)!, output: "完成" }
    ] } });
    expect(screen.queryByText("完成")).toBeNull();
    expect(firstSummary.getAttribute("aria-expanded")).toBe("false");
    expect(secondSummary.getAttribute("aria-expanded")).toBe("true");
    expect(secondSummary.closest(".codex-app-server-event")!.querySelector(".codex-app-server-tool-heading")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("confirms OpenCode history deletion, protects the active thread, and preserves drafts on failure", async () => {
    const base = { threadId: "thread-1", provider: "opencode" as const, mode: "default" as const, executionPermission: "askApproval" as const,
      busy: false, error: null, pendingPlan: null, items: [], approvals: [], questions: [], capabilities: {
        history: true, forkHistory: true, deleteHistory: true, plan: false, attachments: true, permissions: false } };
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce(base);
    const deleteThread = vi.fn().mockRejectedValueOnce(new Error("删除失败")).mockResolvedValue(undefined);
    window.codexAppServerApi.deleteThread = deleteThread;
    listHistory.mockResolvedValue({ data: [
      { id: "thread-1", title: "当前任务", updatedAt: 1, source: "OpenCode", status: "saved" },
      { id: "old-1", title: "旧任务", updatedAt: 1, source: "OpenCode", status: "saved" }
    ], nextCursor: null });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      render(<CodexAppServerSession sessionId="run-1" />);
      await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
      fireEvent.change(screen.getByRole("textbox", { name: "图形对话输入" }), { target: { value: "保留草稿" } });
      fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
      await screen.findByText("会话 ID：old-1");
      const row = (id: string) => within(screen.getByText(`会话 ID：${id}`).closest(".codex-app-server-history-row") as HTMLElement);
      expect(row("thread-1").getByRole("button", { name: "删除" })).toHaveProperty("disabled", true);
      fireEvent.click(row("old-1").getByRole("button", { name: "删除" }));
      expect(deleteThread).not.toHaveBeenCalled();
      confirm.mockReturnValue(true);
      fireEvent.click(row("old-1").getByRole("button", { name: "删除" }));
      await screen.findByText("删除失败");
      expect(screen.getByRole("textbox", { name: "图形对话输入" })).toHaveProperty("value", "保留草稿");
      listHistory.mockResolvedValueOnce({ data: [], nextCursor: null });
      fireEvent.click(row("old-1").getByRole("button", { name: "删除" }));
      await waitFor(() => expect(screen.queryByText("会话 ID：old-1")).toBeNull());
      expect(deleteThread).toHaveBeenCalledWith("run-1", "old-1");
      expect(screen.getByRole("textbox", { name: "图形对话输入" })).toHaveProperty("value", "保留草稿");
    } finally { confirm.mockRestore(); }
  });

  it("shows only advertised OpenCode history actions and switches after a successful fork", async () => {
    const base = { threadId: "thread-1", provider: "opencode" as const, mode: "default" as const, executionPermission: "askApproval" as const,
      busy: false, error: null, pendingPlan: null, items: [], approvals: [], capabilities: { history: true, plan: false, attachments: true, permissions: false } };
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce(base);
    listHistory.mockResolvedValue({ data: [{ id: "old-1", title: "旧任务", updatedAt: 1, source: "OpenCode", status: "saved" }], nextCursor: null });
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    await screen.findByText("会话 ID：old-1");
    expect(screen.queryByRole("button", { name: "分叉" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    act(() => changed({ id: "run-1", snapshot: { ...base, capabilities: { ...base.capabilities, forkHistory: true } } }));
    let finish: (value: any) => void = () => {};
    forkThread.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "分叉" }));
    expect(screen.getByRole("button", { name: "分叉" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "分叉" }));
    expect(forkThread).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ...base, threadId: "branch" }));
    expect(screen.queryByRole("dialog", { name: "历史会话" })).toBeNull();
  });

  it("forks the current Codex timeline through the selected turn", async () => {
    let finish!: (value: any) => void;
    forkTurnToNewSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const onSessionCreated = vi.fn();
    const setDraft = vi.fn();
    render(<SessionView sessionId="run-1" draft="保留草稿" setDraft={setDraft} onSessionCreated={onSessionCreated} />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", provider: "codex", mode: "default",
      busy: false, error: null, approvals: [], items: [
        { id: "user-1", type: "userMessage", turnId: "turn-1", text: "第一个问题" },
        { id: "answer-1", type: "agentMessage", turnId: "turn-1", text: "第一个回答" },
        { id: "user-2", type: "userMessage", turnId: "turn-2", text: "第二个问题" },
        { id: "answer-2", type: "agentMessage", turnId: "turn-2", text: "第二个回答" }
      ] } }));
    const buttons = screen.getAllByRole("button", { name: "从此回合新建会话" });
    expect(buttons).toHaveLength(2);
    expect(buttons[0].parentElement?.previousElementSibling).toHaveProperty("textContent", "第一个回答");
    await screen.findByDisplayValue("保留草稿");
    setDraft.mockClear();
    fireEvent.click(buttons[0]);
    expect(screen.getByRole("button", { name: "正在新建会话…" })).toHaveProperty("disabled", true);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(forkTurnToNewSession).toHaveBeenCalledWith("run-1", "thread-1", "turn-1"));
    expect(forkTurnToNewSession).toHaveBeenCalledTimes(1);
    await act(async () => finish({ id: "run-2" }));
    await waitFor(() => expect(onSessionCreated).toHaveBeenCalledWith("run-2"));
    expect(screen.getByText("第二个回答")).toBeTruthy();
    expect(setDraft).not.toHaveBeenCalled();
    expect(forkThread).not.toHaveBeenCalled();
  });

  it("disables turn forking during a turn and preserves the source on failure", async () => {
    forkTurnToNewSession.mockRejectedValueOnce(new Error("分叉不可用"));
    render(<CodexAppServerSession sessionId="run-1" />);
    const source = { threadId: "thread-1", provider: "codex", mode: "default", error: null, approvals: [],
      items: [{ id: "user-1", type: "userMessage", turnId: "turn-1", text: "问题" },
        { id: "answer-1", type: "agentMessage", turnId: "turn-1", text: "回答" },
        { id: "user-2", type: "userMessage", turnId: "turn-2", text: "运行中的问题" }] };
    act(() => changed({ id: "run-1", snapshot: { ...source, busy: true } }));
    expect(screen.getAllByRole("button", { name: "从此回合新建会话" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "从此回合新建会话" })).toHaveProperty("disabled", true);
    act(() => changed({ id: "run-1", snapshot: { ...source, busy: false } }));
    fireEvent.click(screen.getAllByRole("button", { name: "从此回合新建会话" })[0]);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "新建会话失败：分叉不可用");
    expect(screen.getByText("回答")).toBeTruthy();
  });

  it("toggles reasoning in a mounted session and restores streaming updates", async () => {
    const { rerender } = render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    const snapshot = { threadId: "thread-1", mode: "default", busy: false, error: null, approvals: [], items: [
      { id: "r", turnId: "turn-1", type: "reasoning", summary: ["visible reasoning"] },
      { id: "reply", turnId: "turn-1", type: "agentMessage", text: "visible reply" }
    ] };
    changed({ id: "run-1", snapshot });
    await screen.findByText("visible reasoning");
    rerender(<CodexAppServerSession sessionId="run-1" minimalMode />);
    expect(screen.queryByText("visible reasoning")).toBeNull();
    expect(screen.getByText("visible reply")).toBeTruthy();
    changed({ id: "run-1", snapshot: { ...snapshot, items: [{ ...snapshot.items[0], summary: ["new reasoning"] }, snapshot.items[1]] } });
    await waitFor(() => expect(screen.queryByText("new reasoning")).toBeNull());
    rerender(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByText("new reasoning");
  });

  it("shows Codex reasoning and lifecycle events in order between tool groups", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false, error: null, approvals: [], items: [
      { id: "cmd-1", turnId: "turn-1", type: "commandExecution", command: "pwd", status: "completed" },
      { id: "reason-1", turnId: "turn-1", type: "reasoning", summary: ["检查项目", "准备测试"] },
      { id: "cmd-2", turnId: "turn-1", type: "commandExecution", command: "pnpm test", status: "completed" },
      { id: "collab-1", turnId: "turn-1", type: "collabToolCall", tool: "spawn_agent", status: "completed", newThreadId: "child-1" },
      { id: "image-1", turnId: "turn-1", type: "imageView", path: "C:/project/screenshot.png" },
      { id: "review-start", turnId: "turn-1", type: "enteredReviewMode", review: "当前改动" },
      { id: "review-end", turnId: "turn-1", type: "exitedReviewMode", review: "发现一个问题" },
      { id: "compact-1", turnId: "turn-1", type: "contextCompaction", status: "completed" },
      { id: "future-1", turnId: "turn-1", type: "futureEvent", secret: "must not render" }
    ] } });
    await screen.findByText("检查项目");
    const timeline = document.querySelector(".codex-app-server-messages")!;
    const entries = Array.from(timeline.querySelectorAll(":scope > article, :scope > section"));
    expect(entries.map(entry => entry.textContent)).toEqual([
      expect.stringContaining("工具调用 · 1 项"), expect.stringContaining("检查项目"),
      expect.stringContaining("工具调用 · 1 项"), expect.stringContaining("协作调用 · spawn_agent"),
      expect.stringContaining("C:/project/screenshot.png"), expect.stringContaining("开始代码审查"),
      expect.stringContaining("发现一个问题"),
      expect.stringContaining("未识别的事件类型：futureEvent")
    ]);
    expect(timeline.textContent).not.toContain("must not render");
    expect(timeline.textContent).not.toContain("上下文压缩完成");
    expect(screen.getAllByRole("button", { name: /工具调用 · 1 项/ })).toHaveLength(2);
  });

  it("folds commands and file changes into one ordered group", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false, error: null, approvals: [], items: [
      { id: "cmd-1", type: "commandExecution", command: "pwd", status: "completed" },
      { id: "file-1", type: "fileChange", changes: [{ path: "src/App.tsx", kind: "update" }], status: "completed" },
      { id: "cmd-2", type: "commandExecution", command: "pnpm build", status: "completed" }
    ] } });
    const summary = await screen.findByRole("button", { name: /工具调用 · 3 项/ });
    const details = summary.closest(".codex-app-server-event")!;
    expect(document.querySelectorAll(".codex-app-server-event")).toHaveLength(1);
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(summary.textContent).toContain("已完成");
    fireEvent.click(summary);
    const calls = Array.from(details.querySelectorAll(".codex-app-server-tool"));
    expect(calls.map(call => call.querySelector("strong")?.textContent)).toEqual(["执行命令", "文件变更", "执行命令"]);
    expect(calls.map(call => call.textContent)).toEqual([expect.stringContaining("pwd"), expect.stringContaining("src/App.tsx"), expect.stringContaining("pnpm build")]);
    expect(calls.map(call => call.querySelector("button")?.getAttribute("aria-expanded"))).toEqual(["false", "false", "false"]);
    expect(calls.every(call => !call.querySelector(".codex-app-server-tool-details"))).toBe(true);
    fireEvent.click(calls[1].querySelector("button")!);
    expect(screen.getAllByText("src/App.tsx")).toHaveLength(2);
    expect(calls[0].querySelector(".codex-app-server-tool-details")).toBeNull();
  });

  it("keeps a file approval visible while its tool group is collapsed", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [
      { id: "file-1", type: "fileChange", changes: [{ path: "src/App.tsx" }], status: "pending" }
    ], approvals: [{ requestId: 10, method: "item/fileChange/requestApproval", params: { itemId: "file-1" } }] } });
    const summary = await screen.findByRole("button", { name: /工具调用 · 1 项/ });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("文件修改确认")).toBeTruthy();
    expect(screen.getByRole("button", { name: "批准一次" })).toBeTruthy();
  });

  it("keeps streamed tools collapsed and preserves manual expansion through replies", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    const base = { threadId: "thread-1", mode: "default", busy: true, error: null, approvals: [] };
    const first = { id: "cmd-1", turnId: "turn-1", type: "commandExecution", command: "pnpm test", status: "inProgress" };
    changed({ id: "run-1", snapshot: { ...base, items: [first] } });
    const summary = await screen.findByRole("button", { name: /工具调用 · 1 项/ });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    changed({ id: "run-1", snapshot: { ...base, items: [{ ...first, output: "执行中" },
      { id: "reply-1", turnId: "turn-1", type: "agentMessage", text: "" }] } });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    changed({ id: "run-1", snapshot: { ...base, items: [{ ...first, output: "执行中" },
      { id: "reply-1", turnId: "turn-1", type: "agentMessage", text: "测试完成" }] } });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(summary);
    const command = screen.getByRole("button", { name: /执行命令.*pnpm test/ });
    expect(command.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("执行中")).toBeNull();
    fireEvent.click(command);
    expect(screen.getByText("执行中")).toBeTruthy();
    act(() => changed({ id: "run-1", snapshot: { ...base, items: [{ ...first, output: "执行中" },
      { id: "reply-1", turnId: "turn-1", type: "agentMessage", text: "测试完成，结果如下" }] } }));
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(command.getAttribute("aria-expanded")).toBe("true");
    act(() => changed({ id: "run-1", snapshot: { ...base, items: [{ ...first, output: "执行中" },
      { id: "reply-1", turnId: "turn-1", type: "agentMessage", text: "测试完成，结果如下" },
      { id: "cmd-2", turnId: "turn-1", type: "commandExecution", command: "pnpm build", status: "inProgress" }] } }));
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    const newest = screen.getAllByRole("button", { name: /工具调用 · 1 项/ })[1];
    expect(newest.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps loaded history collapsed and renders ACP search, file, and generic tool results", async () => {
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({ threadId: "history-1", provider: "opencode",
      mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, approvals: [], items: [
        { id: "search-1", type: "toolCall", toolKind: "search", toolName: "Search sources", output: "3 matches", status: "completed" },
        { id: "edit-1", type: "toolCall", toolKind: "edit", toolName: "Update App.tsx", locations: [{ path: "src/App.tsx" }], status: "completed" },
        { id: "other-1", type: "toolCall", toolKind: "other", toolName: "Custom tool", output: "Done", status: "completed" }
      ] });
    render(<CodexAppServerSession sessionId="run-1" />);
    const summary = await screen.findByRole("button", { name: /工具调用 · 3 项/ });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(summary);
    const calls = Array.from(document.querySelectorAll(".codex-app-server-tool"));
    expect(calls.map(call => call.querySelector("[data-kind]")?.getAttribute("data-kind"))).toEqual(["search", "file", "other"]);
    expect(calls.map(call => call.querySelector("button")?.getAttribute("aria-expanded"))).toEqual(["false", "false", "false"]);
    expect(screen.queryByText("3 matches")).toBeNull();
    expect(screen.queryByText("Done")).toBeNull();
    calls.forEach(call => fireEvent.click(call.querySelector("button")!));
    expect(screen.getAllByText("src/App.tsx")).toHaveLength(2);
    expect(screen.getByText("3 matches")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("shows Codex MCP and web search tool details with a generic result fallback", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, approvals: [], items: [
      { id: "mcp-1", type: "mcpToolCall", server: "docs", tool: "find", arguments: { topic: "ACP" }, result: { count: 2 }, status: "completed" },
      { id: "web-1", type: "webSearch", query: "ACP protocol", result: "3 pages", status: "completed" }
    ] } });
    const summary = await screen.findByRole("button", { name: /工具调用 · 2 项/ });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(summary);
    expect(screen.getByText("find")).toBeTruthy();
    expect(screen.getByText("docs")).toBeTruthy();
    expect(screen.queryByText("3 pages")).toBeNull();
    const calls = Array.from(document.querySelectorAll(".codex-app-server-tool"));
    calls.forEach(call => fireEvent.click(call.querySelector("button")!));
    expect(screen.getAllByText("docs")).toHaveLength(2);
    expect(screen.getAllByText("ACP protocol")).toHaveLength(2);
    expect(screen.getByText("3 pages")).toBeTruthy();
  });

  it("shows confirmation below a completed plan and executes it only once", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: false, error: null,
      pendingPlan: { itemId: "plan-1" }, approvals: [], items: [{ id: "plan-1", type: "plan", text: "# 正式计划" }] } });
    const confirm = await screen.findByRole("group", { name: "确认执行计划" });
    expect(confirm.closest("article")?.textContent).toContain("正式计划");
    fireEvent.click(screen.getByRole("button", { name: "执行计划" }));
    fireEvent.click(screen.getByRole("button", { name: "执行计划" }));
    await waitFor(() => expect(executePlan).toHaveBeenCalledTimes(1));
    expect(executePlan).toHaveBeenCalledWith("run-1", "plan-1");
  });

  it("dismisses a plan without starting execution", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: false, error: null,
      pendingPlan: { itemId: "plan-1" }, approvals: [], items: [{ id: "plan-1", type: "plan", text: "# 正式计划" }] } });
    fireEvent.click(await screen.findByRole("button", { name: "暂不执行" }));
    await waitFor(() => expect(dismissPlan).toHaveBeenCalledWith("run-1", "plan-1"));
    await waitFor(() => expect(screen.queryByRole("group", { name: "确认执行计划" })).toBeNull());
    expect(executePlan).not.toHaveBeenCalled();
  });

  it("renders a plan restored from history", async () => {
    listHistory.mockResolvedValueOnce({ data: [{ id: "old-thread", title: "计划会话", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: null });
    resume.mockResolvedValueOnce({ threadId: "old-thread", mode: "default", busy: false, error: null,
      items: [{ id: "old-plan", type: "plan", text: "## 历史计划" }], approvals: [] });
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "恢复前的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    fireEvent.click(await screen.findByRole("button", { name: /计划会话/ }));
    expect(await screen.findByRole("heading", { name: "历史计划" })).toBeTruthy();
    expect(input.value).toBe("");
  });

  it("switches mode, resumes history, and keeps selected files until sending", async () => {
    listHistory.mockResolvedValueOnce({ data: [{ id: "old-thread", title: "之前的任务", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: null });
    chooseFiles.mockResolvedValueOnce(["C:\\files\\notes.txt"]);
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^模式/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Plan/ }));
    await waitFor(() => expect(setMode).toHaveBeenCalledWith("run-1", "plan"));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    fireEvent.click(await screen.findByRole("button", { name: /之前的任务/ }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith("run-1", "old-thread"));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "附加文件" }));
    expect(await screen.findByText("notes.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "", ["C:\\files\\notes.txt"], []));
  });

  it("searches workspace files after @ and inserts the selected relative path without sending", async () => {
    searchWorkspaceEntries.mockResolvedValue({ root: "C:\\work", results: [
      { name: "src", path: "C:\\work\\src", relativePath: "src", type: "directory" },
      { name: "alpha.ts", path: "C:\\work\\alpha.ts", relativePath: "alpha.ts", type: "file" },
      { name: "beta.ts", path: "C:\\work\\src\\beta.ts", relativePath: "src\\beta.ts", type: "file" }
    ] });
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "查看 @be 后续", selectionStart: 6 } });
    await waitFor(() => expect(searchWorkspaceEntries).toHaveBeenCalledWith("run-1", "be"));
    const list = await screen.findByRole("listbox", { name: "搜索工作区文件" });
    await waitFor(() => expect(list.querySelectorAll('[role="option"]')).toHaveLength(2));
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("查看 @src\\beta.ts  后续");
    expect(screen.queryByRole("listbox", { name: "搜索工作区文件" })).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it("supports mouse selection, Escape, and prevents Enter from sending while searching", async () => {
    searchWorkspaceEntries.mockResolvedValue({ root: "C:\\work", results: [
      { name: "note.txt", path: "C:\\work\\note.txt", relativePath: "note.txt", type: "file" }
    ] });
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "@note", selectionStart: 5 } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("option", { name: /note.txt/ }));
    expect(input.value).toBe("@note.txt ");
    fireEvent.change(input, { target: { value: "@note", selectionStart: 5 } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "搜索工作区文件" })).toBeNull();
  });

  it("shows file search errors and clears results when the session changes", async () => {
    searchWorkspaceEntries.mockRejectedValueOnce(new Error("offline"));
    const { rerender } = render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "@a", selectionStart: 2 } });
    expect(await screen.findByRole("alert", { name: "" })).toHaveProperty("textContent", "搜索失败：offline");
    rerender(<CodexAppServerSession sessionId="run-2" />);
    expect(screen.queryByRole("listbox", { name: "搜索工作区文件" })).toBeNull();
  });

  it("ignores an older file search response after the query changes", async () => {
    let resolveOld!: (value: { root: string; results: Array<{ name: string; path: string; relativePath: string; type: "file" }> }) => void;
    searchWorkspaceEntries.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ root: "C:\\work", results: [{ name: "new.ts", path: "C:\\work\\new.ts", relativePath: "new.ts", type: "file" }] });
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "@old", selectionStart: 4 } });
    await waitFor(() => expect(searchWorkspaceEntries).toHaveBeenCalledWith("run-1", "old"));
    fireEvent.change(input, { target: { value: "@new", selectionStart: 4 } });
    expect(await screen.findByRole("option", { name: /new.ts/ })).toBeTruthy();
    await act(async () => { resolveOld({ root: "C:\\work", results: [{ name: "old.ts", path: "C:\\work\\old.ts", relativePath: "old.ts", type: "file" }] }); });
    expect(screen.queryByRole("option", { name: /old.ts/ })).toBeNull();
  });

  it("toggles Plan and Exec with Shift+Tab in the focused composer", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "保留草稿" } });
    input.focus();

    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true, ctrlKey: true });
    expect(setMode).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(screen.getByPlaceholderText("向 Codex 发送消息").parentElement?.getAttribute("data-mode")).toBe("plan"));
    expect(setMode).toHaveBeenCalledWith("run-1", "plan");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("保留草稿");

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(screen.getByPlaceholderText("向 Codex 发送消息").parentElement?.getAttribute("data-mode")).toBe("default"));
    expect(setMode).toHaveBeenLastCalledWith("run-1", "default");
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^模式/ }));
    expect(screen.getByRole("radio", { name: "Exec" }).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Exec" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "模式" }), { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "更多操作" }));
    expect(input.value).toBe("保留草稿");

  });

  it("toggles Plan and Full Access with Shift+Tab in a CodeBuddy session", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    act(() => changed({ id: "run-1", snapshot: { threadId: "buddy-1", provider: "codebuddy", nativeMode: "default",
      nativeModes: [{ id: "default", name: "Standard" }, { id: "plan", name: "Plan" }, { id: "bypassPermissions", name: "Full Access" }],
      mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, items: [], approvals: [] } }));
    input.focus();

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(setNativeMode).toHaveBeenCalledWith("run-1", "plan"));
    expect(await screen.findByText("模式：Plan")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(setNativeMode).toHaveBeenLastCalledWith("run-1", "bypassPermissions"));
    expect(await screen.findByText("模式：Full Access")).toBeTruthy();
  });

  it("toggles only Build and Plan with Shift+Tab in an OpenCode session", async () => {
    const modes = [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }, { id: "review", name: "Review" }];
    const openCodeSnapshot = (nativeMode: string) => ({ threadId: "open-1", provider: "opencode", nativeMode,
      nativeModes: modes, mode: nativeMode === "plan" ? "plan" : "default", executionPermission: "askApproval",
      busy: false, error: null, pendingPlan: null, items: [], approvals: [] });
    setNativeMode.mockImplementationOnce(async (_id, modeId) => openCodeSnapshot(modeId))
      .mockImplementationOnce(async (_id, modeId) => openCodeSnapshot(modeId));
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement;
    act(() => changed({ id: "run-1", snapshot: openCodeSnapshot("build") }));
    fireEvent.change(input, { target: { value: "保留草稿" } });
    input.focus();
    expect(screen.getByText(/Shift\+Tab 切换 Build \/ Plan/)).toBeTruthy();

    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true, ctrlKey: true });
    expect(setNativeMode).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(setNativeMode).toHaveBeenCalledWith("run-1", "plan"));
    expect(await screen.findByText("模式：Plan")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(setNativeMode).toHaveBeenLastCalledWith("run-1", "build"));
    expect(await screen.findByText("模式：Build")).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("保留草稿");
  });

  it("executes the latest OpenCode Plan reply without sending the draft", async () => {
    const items = [
      { id: "old-user", type: "userMessage", text: "旧问题" },
      { id: "old-plan", type: "agentMessage", text: "旧计划" },
      { id: "user", type: "userMessage", text: "制定计划" },
      { id: "plan", type: "agentMessage", text: "实施计划" }
    ];
    const planned = { threadId: "open-1", provider: "opencode" as const, nativeMode: "plan", mode: "plan" as const,
      nativeModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }],
      executionPermission: "askApproval" as const, busy: false, error: null, pendingPlan: null, items, approvals: [] };
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "保留草稿" } });
    act(() => changed({ id: "run-1", snapshot: { ...planned, busy: true } }));
    expect(screen.queryByRole("button", { name: "执行计划" })).toBeNull();
    act(() => changed({ id: "run-1", snapshot: planned }));
    const button = screen.getByRole("button", { name: "执行计划" });
    expect(button.closest("article")?.textContent).toContain("实施计划");
    expect(button.closest("article")?.textContent).not.toContain("旧计划");
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(executePlan).toHaveBeenCalledTimes(1));
    expect(executePlan).toHaveBeenCalledWith("run-1", "plan");
    expect(setNativeMode).not.toHaveBeenCalled();
    act(() => changed({ id: "run-1", snapshot: { ...planned, nativeMode: "build", mode: "default", busy: true } }));
    expect(screen.queryByRole("button", { name: "执行计划" })).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(input.value).toBe("保留草稿");
  });

  it("hides the OpenCode Build shortcut when unavailable, failed, or followed by a new request", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByRole("textbox", { name: "图形对话输入" });
    const base = { threadId: "open-1", provider: "opencode", nativeMode: "plan", mode: "plan",
      nativeModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }],
      executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, approvals: [],
      items: [{ id: "user", type: "userMessage", text: "制定计划" }, { id: "plan", type: "turnPlan", plan: [{ step: "实施", status: "pending" }] }] };
    act(() => changed({ id: "run-1", snapshot: base }));
    expect(screen.getByRole("button", { name: "执行计划" })).toBeTruthy();
    for (const changes of [
      { nativeModes: [{ id: "plan", name: "Plan" }] },
      { error: "计划失败" },
      { items: [...base.items, { id: "next", type: "userMessage", text: "再想想" }] }
    ]) {
      act(() => changed({ id: "run-1", snapshot: { ...base, ...changes } }));
      expect(screen.queryByRole("button", { name: "执行计划" })).toBeNull();
    }
  });

  it("keeps the OpenCode execute button available after execution setup fails", async () => {
    executePlan.mockRejectedValueOnce(new Error("模式切换失败"));
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByRole("textbox", { name: "图形对话输入" });
    act(() => changed({ id: "run-1", snapshot: { threadId: "open-1", provider: "opencode", nativeMode: "plan",
      nativeModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }], mode: "plan",
      executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, approvals: [],
      items: [{ id: "user", type: "userMessage", text: "制定计划" }, { id: "plan", type: "agentMessage", text: "计划内容" }] } }));
    fireEvent.click(screen.getByRole("button", { name: "执行计划" }));
    expect((await screen.findByRole("alert")).textContent).toContain("模式切换失败");
    expect(screen.getByRole("button", { name: "执行计划" })).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not switch OpenCode modes while busy or when Build and Plan are unavailable", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement;
    const base = { threadId: "open-1", provider: "opencode", nativeMode: "build", mode: "default",
      executionPermission: "askApproval", error: null, pendingPlan: null, items: [], approvals: [] };
    act(() => changed({ id: "run-1", snapshot: { ...base, busy: false,
      nativeModes: [{ id: "build", name: "Build" }] } }));
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(setNativeMode).not.toHaveBeenCalled();

    act(() => changed({ id: "run-1", snapshot: { ...base, busy: true,
      nativeModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }] } }));
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(setNativeMode).not.toHaveBeenCalled();
  });

  it("shows an OpenCode shortcut mode change failure", async () => {
    setNativeMode.mockRejectedValueOnce(new Error("模式切换失败"));
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement;
    act(() => changed({ id: "run-1", snapshot: { threadId: "open-1", provider: "opencode", nativeMode: "build",
      nativeModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }], mode: "default",
      executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, items: [], approvals: [] } }));
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect((await screen.findByRole("alert")).textContent).toContain("模式切换失败");
    expect(screen.getByText("模式：Build")).toBeTruthy();
  });

  it.each([true, false])("reviews an idle CodeBuddy worker plan: execute=%s", async execute => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByRole("textbox", { name: "图形对话输入" });
    act(() => changed({ id: "run-1", snapshot: { threadId: "buddy-1", provider: "codebuddy", nativeMode: "default",
      mode: "default", executionPermission: "askApproval", busy: false, error: null,
      pendingPlan: { itemId: "worker-plan" }, items: [{ id: "worker-plan", type: "plan", text: "# Worker plan" }], approvals: [] } }));
    expect(screen.getByText("确认后将允许请求方执行此计划。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: execute ? "执行计划" : "继续修改" }));
    await waitFor(() => expect(execute ? executePlan : dismissPlan).toHaveBeenCalledWith("run-1", "worker-plan"));
    expect(setNativeMode).not.toHaveBeenCalled();
  });

  it("keeps a busy CodeBuddy plan review actionable and blocks the mode shortcut until it is answered", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement;
    act(() => changed({ id: "run-1", snapshot: { threadId: "buddy-1", provider: "codebuddy", nativeMode: "plan",
      nativeModes: [{ id: "plan", name: "Plan" }, { id: "bypassPermissions", name: "Full Access" }],
      mode: "plan", executionPermission: "askApproval", busy: true, error: null,
      pendingPlan: { itemId: "codebuddy-plan:91" }, items: [{ id: "codebuddy-plan:91", type: "plan", text: "# 实施计划" }], approvals: [] } }));
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(setNativeMode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "继续修改" }));
    await waitFor(() => expect(dismissPlan).toHaveBeenCalledWith("run-1", "codebuddy-plan:91"));
  });

  it("pastes multiple copied files in order and continues after a failure", async () => {
    const files = ["first.jpg", "bad.png", "last.webp"].map(name => {
      const file = new File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });
      Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1, 2, 3]).buffer });
      return file;
    });
    pasteImage.mockResolvedValueOnce({ status: "saved", path: "C:\\project\\first.jpg", size: 3 })
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce({ status: "saved", path: "C:\\project\\last.webp", size: 3 });
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    fireEvent.paste(input, { clipboardData: { files, items: [{ type: "image/jpeg" }] } });
    await screen.findByText("last.webp");
    expect(pasteImage).toHaveBeenNthCalledWith(1, "run-1", { name: "first.jpg", bytes: new Uint8Array([1, 2, 3]) });
    expect(pasteImage).toHaveBeenNthCalledWith(3, "run-1", { name: "last.webp", bytes: new Uint8Array([1, 2, 3]) });
    expect((await screen.findByRole("alert")).textContent).toContain("bad.png：disk full");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "", ["C:\\project\\first.jpg", "C:\\project\\last.webp"], [], [
      { type: "image", path: "C:\\project\\first.jpg" }, { type: "image", path: "C:\\project\\last.webp" }]));
  });

  it("limits a copied file batch to ten attachments", async () => {
    const files = Array.from({ length: 11 }, (_, index) => {
      const file = new File(["x"], `${index}.png`, { type: "image/png" });
      Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1]).buffer });
      pasteImage.mockResolvedValueOnce({ status: "saved", path: `C:\\project\\${index}.png`, size: 1 });
      return file;
    });
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息");
    fireEvent.paste(input, { clipboardData: { files, items: [] } });
    expect((await screen.findByRole("alert")).textContent).toContain("已跳过超出部分");
    expect(pasteImage).toHaveBeenCalledTimes(10);
    // The eleventh result was never consumed.
    pasteImage.mockReset().mockResolvedValue({ status: "saved", path: "C:\\project\\.pannel-handle-images\\capture.png", size: 3 });
  });

  it.each([
    ["empty.png", 0, "图片文件为空"],
    ["large.png", 10 * 1024 * 1024 + 1, "10 MiB"],
    ["drawing.svg", 1, "不支持的图片格式"]
  ])("rejects copied %s before transferring bytes", async (name, size, error) => {
    const file = new File(["x"], name, { type: "image/png" });
    Object.defineProperty(file, "size", { value: size });
    const arrayBuffer = vi.fn();
    Object.defineProperty(file, "arrayBuffer", { value: arrayBuffer });
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息");
    fireEvent.paste(input, { clipboardData: { files: [file], items: [] } });
    expect((await screen.findByRole("alert")).textContent).toContain(error);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(pasteImage).not.toHaveBeenCalled();
  });

  it("discards a copied file when its placeholder is removed while saving", async () => {
    let finish!: (value: { status: "saved"; path: string; size: number }) => void;
    pasteImage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const file = new File(["x"], "copied.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1]).buffer });
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息");
    fireEvent.paste(input, { clipboardData: { files: [file], items: [] } });
    await waitFor(() => expect(pasteImage).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: "" } });
    await act(async () => finish({ status: "saved", path: "C:\\project\\copied.png", size: 1 }));
    await waitFor(() => expect(discardImage).toHaveBeenCalledWith("run-1", "C:\\project\\copied.png"));
    expect(screen.queryByText("copied.png")).toBeNull();
  });

  it("adds pasted images as removable attachments and sends them with text", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "检查这张图" } });
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.paste(input, { clipboardData: { items: [{ type: "image/png" }] } });
    expect(await screen.findByText("capture.png")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "预览 capture.png" }).querySelector("img")?.getAttribute("src"))
      .toBe("data:image/png;base64,AA=="));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "检查这张图", ["C:\\project\\.pannel-handle-images\\capture.png"], [], [
      { type: "text", text: "检查这张图" }, { type: "image", path: "C:\\project\\.pannel-handle-images\\capture.png" }]));
    expect(discardImage).not.toHaveBeenCalled();
  });

  it("sends two pasted images in their text positions and retains the draft after failure", async () => {
    const first = "C:\\project\\.pannel-handle-images\\first.png";
    const second = "C:\\project\\.pannel-handle-images\\second.png";
    pasteImage.mockResolvedValueOnce({ status: "saved", path: first, size: 3 })
      .mockResolvedValueOnce({ status: "saved", path: second, size: 3 });
    submit.mockRejectedValueOnce(new Error("send failed"));
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "甲乙丙" } });
    input.setSelectionRange(1, 1);
    fireEvent.paste(input, { clipboardData: { items: [{ type: "image/png" }] } });
    await screen.findByText("first.png");
    input.setSelectionRange(input.value.length - 1, input.value.length - 1);
    fireEvent.paste(input, { clipboardData: { items: [{ type: "image/png" }] } });
    await screen.findByText("second.png");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "甲乙丙", [first, second], [], [
      { type: "text", text: "甲" }, { type: "image", path: first }, { type: "text", text: "乙" },
      { type: "image", path: second }, { type: "text", text: "丙" }]));
    await waitFor(() => expect(input.value).toContain("〔图片 1〕"));
    expect(input.value).toContain("〔图片 2〕");
    expect(discardImage).not.toHaveBeenCalled();
  });

  it("discards a pasted image when removed before sending", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.paste(input, { clipboardData: { items: [{ type: "image/png" }] } });
    fireEvent.click(await screen.findByRole("button", { name: "移除 capture.png" }));
    await waitFor(() => expect(discardImage).toHaveBeenCalledWith("run-1", "C:\\project\\.pannel-handle-images\\capture.png"));
    await waitFor(() => expect(screen.queryByText("capture.png")).toBeNull());
    expect(submit).not.toHaveBeenCalled();
  });

  it("renders restored user text and images in their original order", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const first = { path: "C:\\project\\first.png", name: "first.png" };
    const second = { path: "C:\\project\\second.png", name: "second.png" };
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false,
      error: null, approvals: [], items: [{ id: "user-1", type: "userMessage", text: "甲乙丙",
        attachments: [first, second], parts: [{ type: "text", text: "甲" }, { type: "image", ...first },
          { type: "text", text: "乙" }, { type: "image", ...second }, { type: "text", text: "丙" }] }] } }));
    await waitFor(() => expect(document.querySelector(".codex-app-server-message.user-message")?.textContent)
      .toBe("甲first.png乙second.png丙"));
    expect(screen.getAllByRole("button", { name: /预览 (first|second)\.png/ })).toHaveLength(2);
  });

  it("shows an attachment preview before sending and in the user message", async () => {
    vi.mocked(window.codexAppServerApi.previewAttachment).mockResolvedValue({ kind: "text", text: "文件内容" });
    chooseFiles.mockResolvedValueOnce(["C:\\project\\notes.txt"]);
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "附加文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "预览 notes.txt" }));
    expect(await screen.findByRole("dialog", { name: "预览 notes.txt" })).toBeTruthy();
    expect(await screen.findByText("文件内容")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false, error: null, approvals: [], items: [
      { id: "user-1", type: "userMessage", text: "检查文件", attachments: [{ path: "C:\\project\\notes.txt", name: "notes.txt" }] }
    ] } });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "预览 notes.txt" })).toHaveLength(2));
  });

  it("clears a draft attachment and its preview when the active thread changes", async () => {
    vi.mocked(window.codexAppServerApi.previewAttachment).mockResolvedValue({ kind: "text", text: "旧内容" });
    chooseFiles.mockResolvedValueOnce(["C:\\project\\old.txt"]);
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "附加文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "预览 old.txt" }));
    expect(await screen.findByRole("dialog", { name: "预览 old.txt" })).toBeTruthy();

    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-2", mode: "default", busy: false,
      error: null, approvals: [], items: [] } }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "预览 old.txt" })).toBeNull());
    expect(screen.queryByRole("button", { name: "预览 old.txt" })).toBeNull();
  });

  it("leaves text paste alone and reports a missing clipboard image", async () => {
    pasteImage.mockResolvedValueOnce({ status: "no_image" });
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.paste(input, { clipboardData: { items: [{ type: "text/plain" }] } });
    expect(pasteImage).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "保留文字" } });
    fireEvent.paste(input, { clipboardData: { items: [{ type: "image/png" }] } });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "剪贴板中没有可用的图片。");
    expect(input.value).toBe("保留文字");
  });

  it("dismisses the current server error and shows a later error", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false,
      error: "服务出错", items: [], approvals: [] } }));
    expect(screen.getByRole("alert")).toHaveProperty("textContent", "服务出错");
    fireEvent.click(screen.getByRole("button", { name: "关闭错误提示" }));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false,
      error: "服务出错", items: [], approvals: [] } }));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false,
      error: "新的错误", items: [], approvals: [] } }));
    expect(screen.getByRole("alert")).toHaveProperty("textContent", "新的错误");
    fireEvent.click(screen.getByRole("button", { name: "关闭错误提示" }));
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false,
      error: null, items: [], approvals: [] } }));
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false,
      error: "新的错误", items: [], approvals: [] } }));
    expect(screen.getByRole("alert")).toHaveProperty("textContent", "新的错误");
  });

  it("dismisses a local error without hiding the server error", async () => {
    pasteImage.mockResolvedValueOnce({ status: "no_image" }).mockResolvedValueOnce({ status: "no_image" });
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false,
      error: "服务出错", items: [], approvals: [] } }));
    fireEvent.paste(input, { clipboardData: { items: [{ type: "image/png" }] } });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "剪贴板中没有可用的图片。");
    fireEvent.click(screen.getByRole("button", { name: "关闭错误提示" }));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.paste(input, { clipboardData: { items: [{ type: "image/png" }] } });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "剪贴板中没有可用的图片。");
  });

  it("shows a CodeBuddy team beside the leader and sends to the selected member", async () => {
    const { container } = render(<CodexAppServerSession sessionId="run-1" />);
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", provider: "codebuddy", mode: "default",
      executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, approvals: [],
      items: [{ id: "lead", type: "agentMessage", text: "领导消息" }],
      team: { name: "review", isAutoTeam: true, hasLiveMembers: true, members: [
        { name: "architect", status: "running", description: "架构审查", items: [
          { id: "member", type: "agentMessage", text: "成员消息" },
          { id: "member-command", type: "commandExecution", command: "pnpm test", output: "成员测试通过", status: "completed" }
        ] },
        { name: "tester", status: "completed", items: [{ id: "tester-message", type: "agentMessage", text: "测试结论" }] }
      ] } } }));
    expect(container.querySelector(".codex-app-server-conversation-layout.has-team")).toBeTruthy();
    expect(screen.getByText("领导消息")).toBeTruthy();
    expect(screen.getByText("成员消息")).toBeTruthy();
    expect(screen.getByText("review · 自动团队")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /工具调用 · 1 项/ }));
    const memberCommand = screen.getByRole("button", { name: /执行命令.*pnpm test/ });
    expect(memberCommand.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("成员测试通过")).toBeNull();
    fireEvent.click(memberCommand);
    expect(screen.getByText("成员测试通过")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /tester/ }));
    expect(screen.getByText("测试结论")).toBeTruthy();
    expect(screen.queryByText("成员消息")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("给成员发送消息…"), { target: { value: "继续测试" } });
    fireEvent.click(screen.getByRole("button", { name: "发送给成员" }));
    await waitFor(() => expect(sendTeamMessage).toHaveBeenCalledWith("run-1", "review", "tester", "继续测试"));
    await waitFor(() => expect(screen.getByPlaceholderText("给成员发送消息…")).toHaveProperty("value", ""));
    sendTeamMessage.mockRejectedValueOnce(new Error("成员暂不可达"));
    fireEvent.change(screen.getByPlaceholderText("给成员发送消息…"), { target: { value: "重试消息" } });
    fireEvent.click(screen.getByRole("button", { name: "发送给成员" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "成员暂不可达");
    expect(screen.getByPlaceholderText("给成员发送消息…")).toHaveProperty("value", "重试消息");
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-2", provider: "codebuddy", mode: "default",
      executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, approvals: [], items: [], team: null } }));
    expect(screen.queryByRole("complementary", { name: "Agent Teams" })).toBeNull();
  });
  it("copies the first original input from a Codex history row, including full attachment paths", async () => {
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({
      threadId: "thread-1", mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, approvals: [],
      items: [{ id: "current", type: "userMessage", text: "当前消息" }]
    });
    listHistory.mockResolvedValueOnce({ data: [{ id: "old-thread", title: "已重命名的标题", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: null });
    readInitialUserInput.mockResolvedValueOnce({ text: "第一行\n第二行", attachments: [
      { path: "C:\\work\\a.txt", name: "a.txt" }, { path: "/tmp/b.png", name: "b.png" }
    ] });
    render(<CodexAppServerSession sessionId="run-1" />);
    expect(screen.queryByRole("button", { name: "复制用户输入" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    fireEvent.click(await screen.findByRole("button", { name: "复制首条用户输入：old-thread" }));
    await waitFor(() => expect(readInitialUserInput).toHaveBeenCalledWith("run-1", "old-thread"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("第一行\n第二行\n\n附件：\nC:\\work\\a.txt\n/tmp/b.png"));
    expect(screen.getByText("首条用户输入 已复制")).toBeTruthy();
  });

  it.each(["codex", "codebuddy", "opencode"] as const)("offers copying historical %s session IDs", async provider => {
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({
      threadId: `${provider}-current`, provider, mode: "default", executionPermission: "askApproval", busy: false,
      error: null, pendingPlan: null, items: [], approvals: []
    });
    listHistory.mockResolvedValueOnce({ data: [{ id: `${provider}-old`, title: "旧会话", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: null });
    render(<CodexAppServerSession sessionId="run-1" />);
    expect(screen.queryByRole("button", { name: "复制会话 ID" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    fireEvent.click(await screen.findByRole("button", { name: `复制会话 ID：${provider}-old` }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`${provider}-old`));
    expect(screen.getByText("会话 ID 已复制")).toBeTruthy();
    if (provider !== "codex") expect(screen.queryByRole("button", { name: `复制首条用户输入：${provider}-old` })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭历史会话" }));
  });

  it("renames CodeBuddy history without showing Codex-only actions", async () => {
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({
      threadId: "current", provider: "codebuddy", mode: "default", executionPermission: "askApproval",
      busy: false, error: null, pendingPlan: null, items: [], approvals: []
    });
    listHistory.mockResolvedValue({ data: [{ id: "old", title: "旧会话", updatedAt: 123, source: "CodeBuddy", status: "saved" }], nextCursor: null });
    render(<CodexAppServerSession sessionId="run-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    fireEvent.click(await screen.findByRole("button", { name: "重命名" }));
    fireEvent.change(screen.getByRole("textbox", { name: "重命名 旧会话" }), { target: { value: "新名称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(renameThread).toHaveBeenCalledWith("run-1", "old", "新名称"));
    expect(screen.queryByRole("button", { name: "置顶" })).toBeNull();
    expect(screen.queryByRole("button", { name: "分叉" })).toBeNull();
    expect(screen.queryByRole("button", { name: "归档" })).toBeNull();
  });

  it("reports clipboard rejection when copying the first historical input", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    listHistory.mockResolvedValueOnce({ data: [{ id: "old-thread", title: "旧会话", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: null });
    readInitialUserInput.mockResolvedValueOnce({ text: "保留原文", attachments: [] });
    render(<CodexAppServerSession sessionId="run-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    fireEvent.click(await screen.findByRole("button", { name: "复制首条用户输入：old-thread" }));
    await waitFor(() => expect(screen.getByText("首条用户输入 复制失败")).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith("保留原文");
  });

});
