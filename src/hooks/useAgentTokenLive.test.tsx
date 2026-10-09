// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTokenLiveSnapshot, TerminalSession } from "../vite-env";
import { useAgentTokenLive, usesGraphicalTokenLive } from "./useAgentTokenLive";

function session(id: string, provider: TerminalSession["agentProvider"] = "codex", type: TerminalSession["type"] = "windows"): TerminalSession {
  return {
    id, title: id, shell: "powershell.exe", cwd: "C:\\repo", createdAt: 1, type, agentProvider: provider,
    ...(type === "wsl" ? { wslDistro: "Ubuntu" } : {})
  };
}

function snapshot(panelSessionId: string): AgentTokenLiveSnapshot {
  return {
    panelSessionId,
    provider: "codex",
    state: "generating",
    tokens: { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 12 },
    capabilities: {
      skills: { availability: "available", totalCalls: 0, items: [] },
      mcp: { availability: "available", totalCalls: 0, servers: [] }
    },
    turnOutputTokens: 2,
    outputTokensPerSecond: 1,
    models: ["gpt-5.6"],
    updatedAt: 1
  };
}

describe("useAgentTokenLive", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("routes CodeBuddy to transcript usage and OpenCode to graphical snapshot usage", () => {
    expect(usesGraphicalTokenLive("opencode")).toBe(false);
    expect(usesGraphicalTokenLive("codebuddy")).toBe(true);
    expect(usesGraphicalTokenLive("codex")).toBe(false);
    expect(usesGraphicalTokenLive(undefined)).toBe(false);
  });

  it("receives graphical OpenCode completion usage and isolates session changes", async () => {
    const listeners: ((value: AgentTokenLiveSnapshot) => void)[] = [];
    const remove = vi.fn();
    window.agentTokenStatsApi = {
      getDashboard: vi.fn(), clear: vi.fn(), onChanged: vi.fn(),
      getLive: vi.fn(async () => null),
      onLiveChanged: vi.fn(callback => { listeners.push(callback); return remove; })
    };
    const graphicalSession = (id: string): TerminalSession => ({ ...session(id, "opencode"), runtimeMode: "app-server" });
    const { result, rerender } = renderHook(({ active }) => useAgentTokenLive(active),
      { initialProps: { active: graphicalSession("open-1") } });
    await waitFor(() => expect(result.current).toEqual({ status: "waiting", provider: "opencode" }));
    expect(window.agentTokenStatsApi.getLive).toHaveBeenCalledWith("open-1");
    const completed = { ...snapshot("open-1"), provider: "opencode" as const, state: "completed" as const,
      models: ["openai/gpt-5"], updatedAt: 1234 };
    act(() => listeners[0](completed));
    expect(result.current).toEqual({ status: "ready", snapshot: completed });

    rerender({ active: graphicalSession("open-2") });
    await waitFor(() => expect(result.current).toEqual({ status: "waiting", provider: "opencode" }));
    expect(remove).toHaveBeenCalledOnce();
    act(() => { listeners[0](completed); listeners[1](completed); });
    expect(result.current).toEqual({ status: "waiting", provider: "opencode" });
    const next = { ...completed, panelSessionId: "open-2" };
    act(() => listeners[1](next));
    expect(result.current).toEqual({ status: "ready", snapshot: next });
  });

  it("loads the active snapshot and ignores events from other sessions", async () => {
    let listener: ((value: AgentTokenLiveSnapshot) => void) | undefined;
    const remove = vi.fn();
    window.agentTokenStatsApi = {
      getDashboard: vi.fn(), clear: vi.fn(), onChanged: vi.fn(),
      getLive: vi.fn(async () => snapshot("panel-1")),
      onLiveChanged: vi.fn((callback) => { listener = callback; return remove; })
    };
    const { result, unmount } = renderHook(() => useAgentTokenLive(session("panel-1")));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => listener?.(snapshot("panel-2")));
    expect(result.current.status === "ready" && result.current.snapshot.panelSessionId).toBe("panel-1");
    unmount();
    expect(remove).toHaveBeenCalled();
  });

  it("supports WSL CodeBuddy and waits for SSH Claude completion snapshots", async () => {
    window.agentTokenStatsApi = {
      getDashboard: vi.fn(), clear: vi.fn(), onChanged: vi.fn(),
      getLive: vi.fn(async () => null), onLiveChanged: vi.fn(() => vi.fn())
    };
    const { result, rerender } = renderHook(({ active }) => useAgentTokenLive(active), {
      initialProps: { active: session("panel-1", "codebuddy", "wsl") }
    });
    await waitFor(() => expect(result.current.status).toBe("waiting"));
    rerender({ active: session("panel-2", "claude", "ssh") });
    await waitFor(() => expect(result.current).toEqual({ status: "waiting", provider: "claude" }));
  });

  it("enables event-driven OpenCode live usage for SSH sessions", async () => {
    window.agentTokenStatsApi = {
      getDashboard: vi.fn(), clear: vi.fn(), onChanged: vi.fn(),
      getLive: vi.fn(async () => null), onLiveChanged: vi.fn(() => vi.fn())
    };
    const { result } = renderHook(() => useAgentTokenLive(session("panel-open", "opencode", "ssh")));

    await waitFor(() => expect(result.current).toEqual({ status: "waiting", provider: "opencode" }));
    expect(window.agentTokenStatsApi.getLive).toHaveBeenCalledWith("panel-open");
  });
});
