// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTokenLiveSnapshot, TerminalSession } from "../vite-env";
import { useAgentTokenLive } from "./useAgentTokenLive";

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

  it("supports WSL CodeBuddy and hides SSH sessions", async () => {
    window.agentTokenStatsApi = {
      getDashboard: vi.fn(), clear: vi.fn(), onChanged: vi.fn(),
      getLive: vi.fn(async () => null), onLiveChanged: vi.fn(() => vi.fn())
    };
    const { result, rerender } = renderHook(({ active }) => useAgentTokenLive(active), {
      initialProps: { active: session("panel-1", "codebuddy", "wsl") }
    });
    await waitFor(() => expect(result.current.status).toBe("waiting"));
    rerender({ active: session("panel-2", "codebuddy", "ssh") });
    expect(result.current).toEqual({ status: "hidden" });
  });
});
