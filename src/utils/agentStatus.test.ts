import { describe, expect, it } from "vitest";
import type { AgentStatusPayload } from "../vite-env";
import { mergeAgentStatus } from "./agentStatus";

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
  it("preserves the last summary when a later status has no summary", () => {
    const previous = status({ lastAssistantMessage: "已完成登录页修复" });
    const incoming = status({ status: "running", eventName: "PreToolUse", timestamp: 2 });

    expect(mergeAgentStatus(previous, incoming).lastAssistantMessage).toBe("已完成登录页修复");
  });

  it("replaces the previous summary with a new non-blank summary", () => {
    const previous = status({ lastAssistantMessage: "旧摘要" });
    const incoming = status({ timestamp: 2, lastAssistantMessage: "  新摘要  " });

    expect(mergeAgentStatus(previous, incoming).lastAssistantMessage).toBe("新摘要");
  });

  it("ignores a blank summary", () => {
    const incoming = status({ lastAssistantMessage: "  \n  " });

    expect(mergeAgentStatus(undefined, incoming)).not.toHaveProperty("lastAssistantMessage");
  });

  it("does not carry a summary across providers", () => {
    const previous = status({ lastAssistantMessage: "Codex 摘要" });
    const incoming = status({ provider: "claude", status: "running", timestamp: 2 });

    expect(mergeAgentStatus(previous, incoming)).not.toHaveProperty("lastAssistantMessage");
  });
});
