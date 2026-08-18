// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConversationOverlay } from "./AgentConversationOverlay";
import type { AgentConversationSnapshot } from "../../vite-env";

const baseSnapshot: AgentConversationSnapshot = {
  enabled: true,
  themeId: "dark-slate",
  locale: "zh-CN",
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

describe("AgentConversationOverlay", () => {
  const hide = vi.fn();
  const focusSession = vi.fn();
  const openExternal = vi.fn();

  beforeEach(() => {
    Object.defineProperty(window, "agentConversationApi", {
      configurable: true,
      value: {
        getSnapshot: vi.fn().mockResolvedValue(baseSnapshot),
        onSnapshot: vi.fn(() => () => undefined),
        hide,
        focusSession,
        openExternal
      }
    });
    Object.defineProperty(window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders intermediate and final Markdown replies", async () => {
    render(<AgentConversationOverlay />);
    expect(await screen.findByText("中间回复")).toBeTruthy();
    expect(screen.getByText("最终回复")).toBeTruthy();
    expect(screen.getByText("配置").tagName).toBe("STRONG");
    expect(screen.getByText("处理完成。")).toBeTruthy();
  });

  it("focuses the session and hides the overlay through controlled APIs", async () => {
    render(<AgentConversationOverlay />);
    const sessionTitle = await screen.findByText("Main");
    expect(sessionTitle.closest("button")).toBeNull();
    fireEvent.click(screen.getByTitle("返回当前会话"));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(focusSession).toHaveBeenCalled();
    expect(hide).toHaveBeenCalled();
  });

  it("marks and cleans up the transparent overlay document roots", async () => {
    const { unmount } = render(<AgentConversationOverlay />);
    await screen.findByText("Main");
    expect(document.documentElement.classList.contains("agent-conversation-window-root")).toBe(true);
    expect(document.body.classList.contains("agent-conversation-window-body")).toBe(true);

    unmount();

    expect(document.documentElement.classList.contains("agent-conversation-window-root")).toBe(false);
    expect(document.body.classList.contains("agent-conversation-window-body")).toBe(false);
  });

  it("shows an explicit remote SSH limitation", async () => {
    window.agentConversationApi.getSnapshot = vi.fn().mockResolvedValue({
      ...baseSnapshot,
      turn: { ...baseSnapshot.turn!, provider: "codebuddy", supported: false, status: "unsupported", messages: [] }
    });
    render(<AgentConversationOverlay />);
    await waitFor(() => expect(screen.getByText("纯远程 SSH 暂不支持实时回复")).toBeTruthy());
  });

  it("searches all messages, highlights matches, and wraps result navigation", async () => {
    render(<AgentConversationOverlay />);
    await screen.findByText("Main");

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const searchInput = screen.getByRole("searchbox", { name: "搜索浮窗内容" });
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
    render(<AgentConversationOverlay />);
    await screen.findByText("Main");
    fireEvent.click(screen.getByRole("button", { name: "搜索内容" }));
    const search = screen.getByRole("search", { name: "内容搜索" });
    fireEvent.change(within(search).getByRole("searchbox"), { target: { value: "不存在" } });
    expect(within(search).getByText("0/0")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("search", { name: "内容搜索" })).toBeNull();
  });
});
