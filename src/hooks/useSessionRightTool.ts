import { useCallback, useEffect, useState } from "react";

export type RightTool = "files" | "git" | "monitor" | "conversation" | "idea" | "debug";

export function resolveRightTool(
  rightTool: RightTool,
  options: { hasSession: boolean; showMonitor: boolean; showIdea: boolean; debugMode: boolean }
): RightTool {
  if (rightTool === "conversation") {
    return rightTool;
  }
  if (rightTool === "idea") {
    return options.showIdea ? "idea" : options.hasSession ? "files" : options.debugMode ? "debug" : "conversation";
  }
  if (rightTool === "monitor") {
    return options.showMonitor ? "monitor" : options.hasSession ? "files" : options.debugMode ? "debug" : options.showIdea ? "idea" : "conversation";
  }
  if (options.hasSession && (rightTool === "files" || rightTool === "git")) {
    return rightTool;
  }
  return options.debugMode ? "debug" : options.hasSession ? "files" : options.showIdea ? "idea" : "conversation";
}

export function useSessionRightTool(activeSessionId: string | undefined, runningSessionIds: string[]) {
  const [rightToolBySessionId, setRightToolBySessionId] = useState<Record<string, RightTool>>({});
  const [rightToolWithoutSession, setRightToolWithoutSession] = useState<RightTool>("idea");

  const runningSessionKey = runningSessionIds.join("\0");
  useEffect(() => {
    const runningIds = new Set(runningSessionIds);
    setRightToolBySessionId((current) => {
      const entries = Object.entries(current).filter(([sessionId]) => runningIds.has(sessionId));
      if (entries.length === Object.keys(current).length) {
        return current;
      }
      return Object.fromEntries(entries) as Record<string, RightTool>;
    });
  }, [runningSessionKey]);

  const setRightTool = useCallback((tool: RightTool) => {
    if (!activeSessionId) {
      setRightToolWithoutSession(tool);
      return;
    }
    setRightToolBySessionId((current) => (
      current[activeSessionId] === tool
        ? current
        : { ...current, [activeSessionId]: tool }
    ));
  }, [activeSessionId]);

  return {
    rightTool: activeSessionId ? rightToolBySessionId[activeSessionId] ?? "files" : rightToolWithoutSession,
    setRightTool
  };
}
