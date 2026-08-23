// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConversationPanel } from "./AgentConversationPanel";
import type { AgentConversationSnapshot } from "../../vite-env";

const baseSnapshot: AgentConversationSnapshot = {
  activeSessionId: "panel-1",
  turn: {
    sessionId: "panel-1",
    sessionTitle: "Main",
    provider: "codex",
    status: "running",
    supported: true,
    messages: [
      { id: "one", provider: "codex", kind: "commentary", text: "正在检查 **配置**。", timestamp: 1 },
      { id: "two", provider: "codex", kind: "final", text: "处理完成。", timestamp: 2 }
    ]
  }
};

describe("AgentConversationPanel", () => {
  const openExternal = vi.fn();
  const listHistory = vi.fn();
  const getHistoryMessages = vi.fn();

  beforeEach(() => {
    Object.defineProperty(window, "agentConversationApi", {
      configurable: true,
      value: {
        openExternal,
        listHistory,
        getHistoryMessages
      }
    });
    Object.defineProperty(window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } });
  });

  it("lists native history and opens a selected conversation without exposing file paths", async () => {
    listHistory.mockResolvedValue({
      items: [{
        ref: "codebuddy:buddy-one",
        provider: "codebuddy",
        title: "Buddy history",
        preview: "Question",
        cwd: "C:\\work",
        createdAt: 1,
        updatedAt: 2,
        archived: false
      }],
      nextCursor: null,
      errors: []
    });
    getHistoryMessages.mockResolvedValue({
      conversationRef: "codebuddy:buddy-one",
      messages: [
        { id: "answer", provider: "codebuddy", kind: "reply", text: "Historical answer", timestamp: 2 },
        { id: "question", provider: "codebuddy", kind: "user", text: "Historical question", timestamp: 1 }
      ],
      nextCursor: null
    });

    render(
      <AgentConversationPanel
        snapshot={{ activeSessionId: "panel-1", turn: null }}
        session={{ id: "panel-1", title: "Terminal", shell: "pwsh", cwd: "C:\\work", createdAt: 1, type: "windows" }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "展开对话历史" }));
    fireEvent.click(await screen.findByRole("button", { name: /Buddy history/ }));
    expect(await screen.findByText("Historical answer")).toBeTruthy();
    expect(screen.getByText("Historical question")).toBeTruthy();
    expect(listHistory).toHaveBeenCalledWith(expect.objectContaining({ panelSessionId: "panel-1", providers: ["codex", "codebuddy", "gemini"], scope: "cwd" }));
    expect(getHistoryMessages).toHaveBeenCalledWith(expect.objectContaining({ conversationRef: "codebuddy:buddy-one" }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders intermediate and final Markdown replies", async () => {
    render(<AgentConversationPanel snapshot={baseSnapshot} />);
    expect(await screen.findByText("中间回复")).toBeTruthy();
    expect(screen.getByText("最终回复")).toBeTruthy();
    expect(screen.getByText("配置").tagName).toBe("STRONG");
    expect(screen.getByText("处理完成。")).toBeTruthy();
  });

  it("renders the newest message first and keeps a following view at the top", () => {
    const { rerender } = render(<AgentConversationPanel snapshot={baseSnapshot} />);
    const messageList = document.querySelector<HTMLElement>(".agent-conversation-messages")!;
    const initialMessages = document.querySelectorAll<HTMLElement>(".agent-conversation-message");

    expect(initialMessages[0].textContent).toContain(baseSnapshot.turn!.messages[1].text);
    expect(initialMessages[1].textContent).toContain(baseSnapshot.turn!.messages[0].text.replace(/\*\*/g, ""));

    messageList.scrollTop = 12;
    fireEvent.scroll(messageList);
    rerender(
      <AgentConversationPanel
        snapshot={{
          ...baseSnapshot,
          turn: {
            ...baseSnapshot.turn!,
            messages: [
              ...baseSnapshot.turn!.messages,
              { id: "three", provider: "codex", kind: "reply", text: "newest reply", timestamp: 3 }
            ]
          }
        }}
      />
    );

    expect(document.querySelector<HTMLElement>(".agent-conversation-message")?.textContent).toContain("newest reply");
    expect(messageList.scrollTop).toBe(0);
  });

  it("renders as an embedded panel without floating-window controls", async () => {
    render(<AgentConversationPanel snapshot={baseSnapshot} />);
    expect(await screen.findByText("Main")).toBeTruthy();
    expect(document.querySelector(".agent-conversation-panel")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
    expect(screen.queryByRole("button", { name: "返回当前会话" })).toBeNull();
  });

  it("shows only conversation details by default and toggles history accessibly", async () => {
    const { rerender } = render(
      <AgentConversationPanel
        snapshot={baseSnapshot}
        session={{ id: "panel-1", title: "Terminal", shell: "pwsh", cwd: "C:\\work", createdAt: 1, type: "windows" }}
      />
    );

    const expandButton = screen.getByRole("button", { name: "展开对话历史" });
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("complementary", { name: "对话历史" })).toBeNull();
    expect(document.querySelector(".agent-conversation-detail")).toBeTruthy();

    fireEvent.click(expandButton);
    const collapseButton = screen.getByRole("button", { name: "收起对话历史" });
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("complementary", { name: "对话历史" })).toBeTruthy();

    fireEvent.click(collapseButton);
    expect(screen.getByRole("button", { name: "展开对话历史" }).getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "展开对话历史" }));
    rerender(
      <AgentConversationPanel
        snapshot={{ ...baseSnapshot, activeSessionId: "panel-2", turn: { ...baseSnapshot.turn!, sessionId: "panel-2" } }}
        session={{ id: "panel-2", title: "Other", shell: "pwsh", cwd: "C:\\other", createdAt: 2, type: "windows" }}
      />
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "展开对话历史" }).getAttribute("aria-expanded")).toBe("false"));
  });

  it("shows an empty state when the active session has no conversation", () => {
    render(<AgentConversationPanel snapshot={{ activeSessionId: "panel-1", turn: null }} />);
    expect(screen.getByText("当前会话暂无 Agent 对话。")).toBeTruthy();
  });

  it("opens Markdown links through the controlled external-link API", () => {
    render(
      <AgentConversationPanel
        snapshot={{
          ...baseSnapshot,
          turn: {
            ...baseSnapshot.turn!,
            messages: [{ id: "link", provider: "codex", kind: "final", text: "[文档](https://example.com)", timestamp: 3 }]
          }
        }}
      />
    );
    fireEvent.click(screen.getByRole("link", { name: "文档" }));
    expect(openExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("shows an explicit remote SSH limitation", async () => {
    const snapshot: AgentConversationSnapshot = {
      ...baseSnapshot,
      turn: { ...baseSnapshot.turn!, provider: "codebuddy", supported: false, status: "unsupported", messages: [] }
    };
    render(<AgentConversationPanel snapshot={snapshot} />);
    await waitFor(() => expect(screen.getByText("纯远程 SSH 暂不支持实时回复")).toBeTruthy());
  });

  it("searches all messages, highlights matches, and wraps result navigation", async () => {
    render(<AgentConversationPanel snapshot={baseSnapshot} />);
    await screen.findByText("Main");

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const searchInput = screen.getByRole("searchbox", { name: "搜索对话内容" });
    fireEvent.change(searchInput, { target: { value: "。" } });

    expect(screen.getByText("1/2")).toBeTruthy();
    const matches = document.querySelectorAll("mark.agent-conversation-search-match");
    expect(matches).toHaveLength(2);
    expect(matches[0].classList.contains("active")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "下一个匹配项" }));
    expect(screen.getByText("2/2")).toBeTruthy();
    expect(document.querySelectorAll("mark.agent-conversation-search-match")[1].classList.contains("active")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "下一个匹配项" }));
    expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "上一个匹配项" }));
    expect(screen.getByText("2/2")).toBeTruthy();
  });

  it("shows an empty search count and closes search with Escape", async () => {
    render(<AgentConversationPanel snapshot={baseSnapshot} />);
    await screen.findByText("Main");
    fireEvent.click(screen.getByRole("button", { name: "搜索内容" }));
    const search = screen.getByRole("search", { name: "内容搜索" });
    fireEvent.change(within(search).getByRole("searchbox"), { target: { value: "不存在" } });
    expect(within(search).getByText("0/0")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("search", { name: "内容搜索" })).toBeNull();
  });
});
