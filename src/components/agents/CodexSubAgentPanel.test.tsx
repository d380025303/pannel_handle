// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CodexSubAgentPanel } from "./CodexSubAgentPanel";
import type { CodexSubAgents } from "../../vite-env";

const state: CodexSubAgents = { expanded: true, selectedThreadId: "a", loading: false, error: null, warning: null,
  members: [{ threadId: "a", parentThreadId: "root", name: "Scout", role: "explorer", task: "Inspect source", status: "running", createdAt: 1, loading: false, error: null,
    items: [{ id: "msg", type: "agentMessage", text: "**Found it**" }, { id: "cmd", type: "commandExecution", command: "rg source", status: "completed", output: "result" }] },
  { threadId: "b", parentThreadId: "a", name: "Helper", role: "", task: "", status: "completed", createdAt: 2, loading: false, error: null, items: [] }] };
afterEach(cleanup);
function fixture(value = state) {
  const setSubAgentView = vi.fn(async () => {}), refreshSubAgents = vi.fn(async () => {});
  Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: { setSubAgentView, refreshSubAgents } });
  render(<CodexSubAgentPanel sessionId="run" threadId="root" state={value} />);
  return { setSubAgentView, refreshSubAgents };
}
describe("Codex sub-agent panel", () => {
  it("renders nested members, task, Markdown and tools without control inputs", () => {
    fixture(); expect(screen.getByText("Found it").tagName).toBe("STRONG");
    expect(screen.getByText("Inspect source")).toBeTruthy(); expect(screen.getByText("Helper")).toBeTruthy();
    expect(screen.getByText("explorer")).toBeTruthy(); expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "折叠 Scout 的子 Agent" })); expect(screen.queryByText("Helper")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /工具调用 · 1 项/ })); expect(screen.getByText("rg source")).toBeTruthy();
  });
  it("selects members, collapses the panel and refreshes through controlled APIs", () => {
    const { setSubAgentView, refreshSubAgents } = fixture();
    fireEvent.click(screen.getByRole("button", { name: /Helper/ })); expect(setSubAgentView).toHaveBeenCalledWith("run", true, "b", "root");
    fireEvent.click(screen.getByRole("button", { name: "子 Agent · 2" })); expect(setSubAgentView).toHaveBeenCalledWith("run", false, undefined, "root");
    fireEvent.click(screen.getByRole("button", { name: "刷新子 Agent" })); expect(refreshSubAgents).toHaveBeenCalledWith("run", "root");
  });
  it("shows retained messages, failures, retry and loading", async () => {
    const { refreshSubAgents } = fixture({ ...state, warning: "列表可能不完整", members: [{ ...state.members[0], error: "读取失败" }] });
    expect(screen.getByText("Found it")).toBeTruthy(); expect(screen.getByText("列表可能不完整")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" })); await waitFor(() => expect(refreshSubAgents).toHaveBeenCalled());
  });
});
