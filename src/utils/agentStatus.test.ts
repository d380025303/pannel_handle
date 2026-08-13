import { describe, expect, it } from "vitest";
import type { AgentStatusPayload } from "../vite-env";
import { mergeAgentStatus, updateAgentStatuses } from "./agentStatus";

function status(overrides: Partial<AgentStatusPayload> = {}): AgentStatusPayload {
  return {
    id: "run-1",
    provider: "codex",
    status: "completed",
    eventName: "Stop",
    timestamp: 1,
    ...overrides
  };
}

describe("mergeAgentStatus", () => {
  it("clears the status and summary for an agent reset", () => {
    const previous = status({ status: "completed", activitySummary: "旧摘要" });
    const incoming = status({ status: "cleared", eventName: "SessionStart", timestamp: 2 });

    expect(mergeAgentStatus(previous, incoming)).toBeUndefined();
  });

  it("clears the last summary when a later status has no summary", () => {
    const previous = status({ activitySummary: "已完成登录页修复" });
    const incoming = status({ status: "running", eventName: "PreToolUse", timestamp: 2 });

    expect(mergeAgentStatus(previous, incoming)).not.toHaveProperty("activitySummary");
  });

  it("replaces the previous summary with a new non-blank summary", () => {
    const previous = status({ activitySummary: "旧摘要" });
    const incoming = status({ timestamp: 2, activitySummary: "  新摘要  " });

    expect(mergeAgentStatus(previous, incoming)?.activitySummary).toBe("新摘要");
  });

  it("ignores a blank summary", () => {
    const previous = status({ activitySummary: "旧摘要" });
    const incoming = status({ activitySummary: "  \n  " });

    expect(mergeAgentStatus(previous, incoming)).not.toHaveProperty("activitySummary");
  });

  it("does not carry a summary across providers", () => {
    const previous = status({ activitySummary: "Codex 摘要" });
    const incoming = status({ provider: "claude", status: "running", timestamp: 2 });

    expect(mergeAgentStatus(previous, incoming)).not.toHaveProperty("activitySummary");
  });

  it("removes only the cleared session and rebuilds it from the next event", () => {
    const current = {
      "run-1": status({ activitySummary: "旧摘要" }),
      "run-2": status({ id: "run-2", provider: "claude", activitySummary: "保留" })
    };

    const cleared = updateAgentStatuses(current, status({ status: "cleared", eventName: "SessionStart" }));
    expect(cleared).toEqual({ "run-2": current["run-2"] });

    const restarted = updateAgentStatuses(cleared, status({
      status: "running",
      eventName: "UserPromptSubmit",
      timestamp: 2,
      activitySummary: "新任务"
    }));
    expect(restarted["run-1"]?.activitySummary).toBe("新任务");
    expect(restarted["run-2"]).toBe(current["run-2"]);
  });
});
