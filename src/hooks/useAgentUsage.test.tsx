// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStatusPayload, AgentUsageSnapshot, TerminalSession } from "../vite-env";
import { AGENT_USAGE_POLL_INTERVAL_MS, CODEBUDDY_USAGE_POLL_INTERVAL_MS, useAgentUsage } from "./useAgentUsage";

function session(id: string, agentProvider?: TerminalSession["agentProvider"]): TerminalSession {
  return {
    id,
    title: id,
    shell: "powershell.exe",
    cwd: "C:\\repo",
    createdAt: 1,
    type: "windows",
    agentProvider
  };
}

function snapshot(id: string, provider: AgentUsageSnapshot["provider"] = "codex"): AgentUsageSnapshot {
  return {
    provider,
    fetchedAt: 1,
    primaryLimitId: id,
    limits: [{ id, name: id, usedPercent: 10, remainingPercent: 90 }]
  };
}

describe("useAgentUsage", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stays hidden for non-Codex sessions", () => {
    const getUsage = vi.fn();
    window.agentUsageApi = { getUsage, cancel: vi.fn() };
    const { result } = renderHook(() => useAgentUsage(session("plain")));
    expect(result.current.state).toEqual({ status: "hidden" });
    expect(getUsage).not.toHaveBeenCalled();
  });

  it("stays hidden for non-Windows CodeBuddy sessions", () => {
    const getUsage = vi.fn();
    window.agentUsageApi = { getUsage, cancel: vi.fn() };
    const codeBuddyWsl = { ...session("codebuddy-wsl", "codebuddy"), type: "wsl" as const, wslDistro: "Ubuntu" };
    const { result } = renderHook(() => useAgentUsage(codeBuddyWsl));
    expect(result.current.state).toEqual({ status: "hidden" });
    expect(getUsage).not.toHaveBeenCalled();
  });

  it("loads usage and force refreshes after a completed Codex event", async () => {
    const getUsage = vi.fn(async () => snapshot("codex"));
    window.agentUsageApi = { getUsage, cancel: vi.fn() };
    let agentStatus: AgentStatusPayload | undefined;
    const activeSession = session("run-1", "codex");
    const { result, rerender } = renderHook(() => useAgentUsage(activeSession, agentStatus));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(getUsage).toHaveBeenCalledWith("run-1", { force: false });

    agentStatus = {
      id: "run-1",
      provider: "codex",
      status: "completed",
      eventName: "Stop",
      timestamp: 2
    };
    rerender();
    await waitFor(() => expect(getUsage).toHaveBeenCalledWith("run-1", { force: true }));
  });

  it("ignores a stale response after switching sessions", async () => {
    let resolveFirst!: (value: AgentUsageSnapshot) => void;
    let resolveSecond!: (value: AgentUsageSnapshot) => void;
    const first = new Promise<AgentUsageSnapshot>(resolve => { resolveFirst = resolve; });
    const second = new Promise<AgentUsageSnapshot>(resolve => { resolveSecond = resolve; });
    const getUsage = vi.fn((id: string) => id === "run-1" ? first : second);
    const cancel = vi.fn();
    window.agentUsageApi = { getUsage, cancel };
    let activeSession = session("run-1", "codex");
    const { result, rerender } = renderHook(() => useAgentUsage(activeSession));

    await waitFor(() => expect(getUsage).toHaveBeenCalledWith("run-1", { force: false }));
    activeSession = session("run-2", "codex");
    rerender();
    await waitFor(() => expect(getUsage).toHaveBeenCalledWith("run-2", { force: false }));
    expect(cancel).toHaveBeenCalledWith("run-1");

    await act(async () => resolveSecond(snapshot("run-2")));
    await waitFor(() => expect(result.current.state.status === "ready" && result.current.state.snapshot.primaryLimitId).toBe("run-2"));
    await act(async () => resolveFirst(snapshot("run-1")));
    expect(result.current.state.status === "ready" && result.current.state.snapshot.primaryLimitId).toBe("run-2");
  });

  it("polls an active Codex session every five minutes", async () => {
    vi.useFakeTimers();
    const getUsage = vi.fn(async () => snapshot("codex"));
    window.agentUsageApi = { getUsage, cancel: vi.fn() };
    renderHook(() => useAgentUsage(session("run-1", "codex")));
    await act(async () => Promise.resolve());
    expect(getUsage).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(AGENT_USAGE_POLL_INTERVAL_MS));
    expect(getUsage).toHaveBeenCalledTimes(2);
  });

  it("polls an active Windows CodeBuddy session every minute", async () => {
    vi.useFakeTimers();
    const getUsage = vi.fn(async () => snapshot("codebuddy-total", "codebuddy"));
    window.agentUsageApi = { getUsage, cancel: vi.fn() };
    renderHook(() => useAgentUsage(session("run-1", "codebuddy")));
    await act(async () => Promise.resolve());
    expect(getUsage).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(CODEBUDDY_USAGE_POLL_INTERVAL_MS));
    expect(getUsage).toHaveBeenCalledTimes(2);
    expect(getUsage).toHaveBeenLastCalledWith("run-1", { force: false });
  });

  it("force refreshes CodeBuddy quota after its completed hook event", async () => {
    const getUsage = vi.fn(async () => snapshot("codebuddy-total", "codebuddy"));
    window.agentUsageApi = { getUsage, cancel: vi.fn() };
    let agentStatus: AgentStatusPayload | undefined;
    const activeSession = session("run-1", "codebuddy");
    const { rerender } = renderHook(() => useAgentUsage(activeSession, agentStatus));
    await waitFor(() => expect(getUsage).toHaveBeenCalledWith("run-1", { force: false }));

    agentStatus = {
      id: "run-1",
      provider: "codebuddy",
      status: "completed",
      eventName: "Stop",
      timestamp: 2
    };
    rerender();
    await waitFor(() => expect(getUsage).toHaveBeenCalledWith("run-1", { force: true }));
  });
});
