// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStatusPayload, TerminalSession } from "../vite-env";
import { useTerminalSessions } from "./useTerminalSessions";

function session(id: string, agentProvider: TerminalSession["agentProvider"]): TerminalSession {
  return {
    id,
    templateId: "template-1",
    title: "Agent",
    shell: "powershell.exe",
    cwd: "C:\\work",
    createdAt: 1,
    type: "windows",
    agentProvider
  };
}

afterEach(cleanup);

describe("useTerminalSessions", () => {
  it("selects the replacement runtime returned by Agent switching", async () => {
    let onSessionsChanged = (_sessions: TerminalSession[]) => {};
    const replacement = session("run-3", "claude");
    window.terminalApi = {
      loadSavedSessions: vi.fn(async () => []),
      getConfig: vi.fn(async () => ({ autoRestore: false, lastActiveSessionIds: [] })),
      onSessionsChanged: vi.fn((callback: (sessions: TerminalSession[]) => void) => {
        onSessionsChanged = callback;
        return () => {};
      }),
      onAgentStatus: vi.fn((_callback: (payload: AgentStatusPayload) => void) => () => {}),
      switchAgent: vi.fn(async () => replacement)
    } as unknown as typeof window.terminalApi;
    window.launchTemplateApi = {
      list: vi.fn(async () => [])
    } as unknown as typeof window.launchTemplateApi;

    const { result } = renderHook(() => useTerminalSessions());
    await waitFor(() => expect(window.terminalApi.loadSavedSessions).toHaveBeenCalled());
    act(() => onSessionsChanged([session("run-1", "codex"), session("run-2", undefined)]));
    expect(result.current.activeId).toBe("run-1");

    await act(async () => result.current.switchAgent("run-1", "claude"));

    expect(window.terminalApi.switchAgent).toHaveBeenCalledWith("run-1", "claude");
    expect(result.current.activeId).toBe("run-3");
  });
});
