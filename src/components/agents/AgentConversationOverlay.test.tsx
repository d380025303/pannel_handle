// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    fireEvent.click(await screen.findByTitle("返回当前会话"));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(focusSession).toHaveBeenCalled();
    expect(hide).toHaveBeenCalled();
  });

  it("shows an explicit remote SSH limitation", async () => {
    window.agentConversationApi.getSnapshot = vi.fn().mockResolvedValue({
      ...baseSnapshot,
      turn: { ...baseSnapshot.turn!, provider: "codebuddy", supported: false, status: "unsupported", messages: [] }
    });
    render(<AgentConversationOverlay />);
    await waitFor(() => expect(screen.getByText("纯远程 SSH 暂不支持实时回复")).toBeTruthy());
  });
});
