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
  it("loads and saves the default shell and forwards only explicit selections", async () => {
    window.terminalApi = {
      loadSavedSessions: vi.fn(async () => []),
      getConfig: vi.fn(async () => ({ autoRestore: false, lastActiveSessionIds: [], defaultWindowsShell: "pwsh" })),
      setConfig: vi.fn(async () => undefined),
      onSessionsChanged: vi.fn(() => () => {}),
      onAgentStatus: vi.fn(() => () => {}),
      createSession: vi.fn(async () => session("new", undefined))
    } as unknown as typeof window.terminalApi;
    window.launchTemplateApi = { list: vi.fn(async () => []) } as unknown as typeof window.launchTemplateApi;
    const { result } = renderHook(() => useTerminalSessions());
    await waitFor(() => expect(result.current.defaultWindowsShell).toBe("pwsh"));
    await act(async () => result.current.changeDefaultWindowsShell("cmd"));
    expect(window.terminalApi.setConfig).toHaveBeenCalledWith({ defaultWindowsShell: "cmd" });
    expect(result.current.defaultWindowsShell).toBe("cmd");
    await act(async () => result.current.createSession({ selectedShellId: "default" }));
    expect(vi.mocked(window.terminalApi.createSession).mock.calls[0][0]).not.toHaveProperty("windowsShell");
    await act(async () => result.current.createSession({ selectedShellId: "powershell" }));
    expect(window.terminalApi.createSession).toHaveBeenLastCalledWith(expect.objectContaining({ type: "windows", windowsShell: "powershell" }));
  });

  it("duplicates a running session in the background and reports launch failures", async () => {
    let onSessionsChanged = (_sessions: TerminalSession[]) => {};
    const duplicateRunningSession = vi.fn()
      .mockResolvedValueOnce(session("run-2", "codex"))
      .mockRejectedValueOnce(new Error("duplicate failed"));
    window.terminalApi = {
      loadSavedSessions: vi.fn(async () => []),
      getConfig: vi.fn(async () => ({ autoRestore: false, lastActiveSessionIds: [] })),
      onSessionsChanged: vi.fn((callback: (sessions: TerminalSession[]) => void) => {
        onSessionsChanged = callback;
        return () => {};
      }),
      onAgentStatus: vi.fn((_callback: (payload: AgentStatusPayload) => void) => () => {}),
      duplicateRunningSession
    } as unknown as typeof window.terminalApi;
    window.launchTemplateApi = {
      list: vi.fn(async () => [])
    } as unknown as typeof window.launchTemplateApi;

    const { result } = renderHook(() => useTerminalSessions());
    await waitFor(() => expect(window.terminalApi.loadSavedSessions).toHaveBeenCalled());
    act(() => onSessionsChanged([session("run-1", "codex")]));

    await act(async () => result.current.duplicateRunningSession("run-1"));
    expect(duplicateRunningSession).toHaveBeenCalledWith("run-1");
    expect(result.current.activeId).toBe("run-1");
    expect(result.current.startupError).toBeNull();

    await act(async () => result.current.duplicateRunningSession("run-1"));
    expect(result.current.activeId).toBe("run-1");
    expect(result.current.startupError).toBe("duplicate failed");
  });

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

  it("selects the replacement runtime returned by graphical Codex model switching", async () => {
    let onSessionsChanged = (_sessions: TerminalSession[]) => {};
    const replacement = { ...session("run-3", "codex"), codexBackend: "openrouter" as const };
    window.terminalApi = {
      loadSavedSessions: vi.fn(async () => []),
      getConfig: vi.fn(async () => ({ autoRestore: false, lastActiveSessionIds: [] })),
      onSessionsChanged: vi.fn((callback: (sessions: TerminalSession[]) => void) => {
        onSessionsChanged = callback;
        return () => {};
      }),
      onAgentStatus: vi.fn((_callback: (payload: AgentStatusPayload) => void) => () => {}),
      switchModelSource: vi.fn(async () => replacement)
    } as unknown as typeof window.terminalApi;
    window.launchTemplateApi = {
      list: vi.fn(async () => [])
    } as unknown as typeof window.launchTemplateApi;

    const { result } = renderHook(() => useTerminalSessions());
    await waitFor(() => expect(window.terminalApi.loadSavedSessions).toHaveBeenCalled());
    act(() => onSessionsChanged([session("run-1", "codex")]));

    await act(async () => result.current.switchCodexGraphicalModel("run-1", "openrouter", "vendor/model"));

    expect(window.terminalApi.switchModelSource).toHaveBeenCalledWith("run-1", "openrouter", true, "vendor/model");
    expect(result.current.activeId).toBe("run-3");
  });

  it("shows, dismisses, and reopens OpenCode empty-response warnings per session and incident", async () => {
    let onSessionsChanged = (_sessions: TerminalSession[]) => {};
    let onAgentStatus = (_payload: AgentStatusPayload) => {};
    window.terminalApi = {
      loadSavedSessions: vi.fn(async () => []),
      getConfig: vi.fn(async () => ({ autoRestore: false, lastActiveSessionIds: [] })),
      onSessionsChanged: vi.fn((callback: (sessions: TerminalSession[]) => void) => {
        onSessionsChanged = callback;
        return () => {};
      }),
      onAgentStatus: vi.fn((callback: (payload: AgentStatusPayload) => void) => {
        onAgentStatus = callback;
        return () => {};
      })
    } as unknown as typeof window.terminalApi;
    window.launchTemplateApi = {
      list: vi.fn(async () => [])
    } as unknown as typeof window.launchTemplateApi;

    const { result } = renderHook(() => useTerminalSessions());
    await waitFor(() => expect(window.terminalApi.loadSavedSessions).toHaveBeenCalled());
    act(() => onSessionsChanged([session("run-1", "opencode"), session("run-2", "opencode")]));

    const warning = (id: string, timestamp: number): AgentStatusPayload => ({
      id,
      provider: "opencode",
      status: "failed",
      eventName: "OpenCodeEmptyResponse",
      timestamp
    });
    act(() => onAgentStatus(warning("run-1", 10)));
    expect(result.current.activeAgentWarning).toMatchObject({ id: "run-1", timestamp: 10 });

    act(() => result.current.dismissActiveAgentWarning());
    expect(result.current.activeAgentWarning).toBeUndefined();

    act(() => onAgentStatus(warning("run-1", 11)));
    expect(result.current.activeAgentWarning).toMatchObject({ id: "run-1", timestamp: 11 });

    act(() => result.current.setActiveId("run-2"));
    expect(result.current.activeAgentWarning).toBeUndefined();
    act(() => onAgentStatus(warning("run-2", 12)));
    expect(result.current.activeAgentWarning).toMatchObject({ id: "run-2", timestamp: 12 });
  });
});
