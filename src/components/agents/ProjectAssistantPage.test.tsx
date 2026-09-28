// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectAssistantPage } from "./ProjectAssistantPage";
import type { ProjectAssistantCodexSession } from "../../vite-env";

vi.mock("./CodexSessionMirror", () => ({ CodexSessionMirror: ({ sessionId }: { sessionId: string }) => <div>Mirror {sessionId}</div> }));

describe("ProjectAssistantPage Codex controls", () => {
  const submitCodex = vi.fn(async () => undefined);
  const switchCodexMode = vi.fn(async () => undefined);
  const send = vi.fn(async () => ({ threadId: "thread", messages: [], pendingAction: null, busy: false, error: null }));
  const newConversation = vi.fn(async () => ({ threadId: "new-thread", messages: [], pendingAction: null, busy: false, error: null }));

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "projectAssistantApi", { configurable: true, value: {
      getSnapshot: async () => ({ threadId: "thread", messages: [], pendingAction: null, busy: false, error: null }),
      start: async () => undefined,
      newConversation,
      send,
      resolve: async () => ({ approved: false }),
      stop: async () => undefined,
      listCodexSessions: async () => [
        { id: "codex-1", title: "First", type: "windows", cwd: "C:\\one", status: "running" },
        { id: "codex-2", title: "Second", type: "wsl", cwd: "/two", status: "running" }
      ],
      submitCodex,
      switchCodexMode,
      onChanged: () => () => undefined,
      onProgress: () => () => undefined
    } });
    Object.defineProperty(window, "terminalApi", { configurable: true, value: {
      onSessionsChanged: () => () => undefined,
      onAgentStatus: () => () => undefined
    } });
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });
  afterEach(cleanup);

  it("routes direct input, mode toggle, and assistant context to the selected instance", async () => {
    render(<ProjectAssistantPage initialSessionId="codex-1" />);
    const selector = await screen.findByRole("combobox", { name: "选择 Codex 会话" });
    fireEvent.change(selector, { target: { value: "codex-2" } });
    expect(screen.getByText("Mirror codex-2")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("向当前 Codex 会话输入内容"), { target: { value: "answer" } });
    fireEvent.click(screen.getByRole("button", { name: "发送给 Codex" }));
    await waitFor(() => expect(submitCodex).toHaveBeenCalledWith("codex-2", "answer"));

    fireEvent.click(screen.getByRole("button", { name: "切换 Plan / 默认模式" }));
    expect(switchCodexMode).toHaveBeenCalledWith("codex-2");

    fireEvent.change(screen.getByPlaceholderText("询问 Codex 进展，或描述希望它执行的操作"), { target: { value: "进展如何" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("进展如何", "codex-2"));
  });

  it("starts a fresh assistant conversation and clears the old view and draft", async () => {
    window.projectAssistantApi.getSnapshot = async () => ({ threadId: "old-thread", messages: [{ role: "assistant", text: "旧消息", at: 1 }], pendingAction: null, busy: false, error: null });
    render(<ProjectAssistantPage />);
    expect(await screen.findByText("旧消息")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("询问 Codex 进展，或描述希望它执行的操作"), { target: { value: "未发送的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    await waitFor(() => expect(newConversation).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText("旧消息")).toBeNull());
    expect((screen.getByPlaceholderText("询问 Codex 进展，或描述希望它执行的操作") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText("Mirror codex-1")).toBeTruthy();
  });

  it("does not mount a mirror for a session removed from the current list", async () => {
    let resolveSessions!: (value: ProjectAssistantCodexSession[]) => void;
    window.projectAssistantApi.listCodexSessions = () => new Promise(resolve => { resolveSessions = resolve; });
    render(<ProjectAssistantPage initialSessionId="closed" />);
    expect(screen.queryByText("Mirror closed")).toBeNull();
    resolveSessions([{ id: "codex-1", title: "First", type: "windows", cwd: "C:\\one", status: "running" }]);
    expect(await screen.findByText("Mirror codex-1")).toBeTruthy();
  });
});
