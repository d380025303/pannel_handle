// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRightTool, useSessionRightTool } from "./useSessionRightTool";

afterEach(cleanup);

describe("useSessionRightTool", () => {
  it("remembers the active right tool independently for each running session", () => {
    const { result, rerender } = renderHook(
      ({ activeId, runningIds }) => useSessionRightTool(activeId, runningIds),
      { initialProps: { activeId: "session-a" as string | undefined, runningIds: ["session-a", "session-b"] } }
    );

    expect(result.current.rightTool).toBe("files");
    act(() => result.current.setRightTool("git"));
    expect(result.current.rightTool).toBe("git");

    rerender({ activeId: "session-b", runningIds: ["session-a", "session-b"] });
    expect(result.current.rightTool).toBe("files");
    act(() => result.current.setRightTool("conversation"));

    rerender({ activeId: "session-a", runningIds: ["session-a", "session-b"] });
    expect(result.current.rightTool).toBe("git");
    rerender({ activeId: "session-b", runningIds: ["session-a", "session-b"] });
    expect(result.current.rightTool).toBe("conversation");
  });

  it("keeps the no-session selection separate from session defaults", () => {
    const { result, rerender } = renderHook(
      ({ activeId, runningIds }) => useSessionRightTool(activeId, runningIds),
      { initialProps: { activeId: undefined as string | undefined, runningIds: [] as string[] } }
    );

    expect(result.current.rightTool).toBe("idea");
    act(() => result.current.setRightTool("conversation"));
    rerender({ activeId: "session-a", runningIds: ["session-a"] });
    expect(result.current.rightTool).toBe("files");
    rerender({ activeId: undefined, runningIds: [] });
    expect(result.current.rightTool).toBe("conversation");
  });

  it("drops state after a session instance closes", () => {
    const { result, rerender } = renderHook(
      ({ activeId, runningIds }) => useSessionRightTool(activeId, runningIds),
      { initialProps: { activeId: "session-a" as string | undefined, runningIds: ["session-a"] } }
    );

    act(() => result.current.setRightTool("monitor"));
    rerender({ activeId: undefined, runningIds: [] });
    rerender({ activeId: "session-a", runningIds: ["session-a"] });
    expect(result.current.rightTool).toBe("files");
  });

  it("falls back when a remembered tool is unavailable for the active session", () => {
    expect(resolveRightTool("monitor", { hasSession: true, showMonitor: false, showIdea: true, debugMode: false })).toBe("files");
    expect(resolveRightTool("idea", { hasSession: true, showMonitor: true, showIdea: false, debugMode: false })).toBe("files");
    expect(resolveRightTool("debug", { hasSession: true, showMonitor: false, showIdea: true, debugMode: false })).toBe("files");
    expect(resolveRightTool("files", { hasSession: false, showMonitor: false, showIdea: true, debugMode: true })).toBe("debug");
    expect(resolveRightTool("git", { hasSession: false, showMonitor: false, showIdea: true, debugMode: false })).toBe("idea");
  });
});
