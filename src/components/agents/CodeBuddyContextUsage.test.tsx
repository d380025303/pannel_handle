// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CodeBuddyContextUsage } from "./CodeBuddyContextUsage";

afterEach(cleanup);

it("waits for ACP data, then shows the context ring and available categories", () => {
  const view = render(<CodeBuddyContextUsage usage={null} />);
  expect(screen.getByRole("button", { name: "等待上下文用量" })).toHaveProperty("disabled", true);
  view.rerender(<CodeBuddyContextUsage usage={{ used: 50000, size: 200000,
    categories: { systemPrompt: 5000, conversation: 45000 }, updatedAt: 1 }} />);
  fireEvent.click(screen.getByRole("button", { name: "上下文用量 25.0%" }));
  expect(screen.getByRole("dialog", { name: "CodeBuddy 上下文用量" })).toBeTruthy();
  expect(screen.getByText(/50,000 \/ 200,000 tokens/)).toBeTruthy();
  expect(screen.getByText("系统提示词")).toBeTruthy();
  expect(screen.getByText("对话")).toBeTruthy();
  expect(screen.queryByText("MCP")).toBeNull();
  view.rerender(<CodeBuddyContextUsage usage={null} />);
  expect(screen.queryByRole("dialog", { name: "CodeBuddy 上下文用量" })).toBeNull();
});

it("labels OpenCode usage without CodeBuddy-specific categories", () => {
  render(<CodeBuddyContextUsage provider="opencode" usage={{ used: 100, size: 1000, categories: {}, updatedAt: 1 }} />);
  fireEvent.click(screen.getByRole("button", { name: "上下文用量 10.0%" }));
  expect(screen.getByRole("dialog", { name: "OpenCode 上下文用量" })).toBeTruthy();
  expect(screen.queryByText("系统提示词")).toBeNull();
});
