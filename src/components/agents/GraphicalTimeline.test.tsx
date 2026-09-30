// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { CodexAppServerSnapshot } from "../../vite-env";
import { CodexEventCard, groupTimeline, TeamMemberTimeline } from "./GraphicalTimeline";

afterEach(cleanup);

type SessionItem = CodexAppServerSnapshot["items"][number];
const tool = (id: string, turnId = "turn-1"): SessionItem => ({ id, turnId, type: "commandExecution", status: "completed" });
const timeline = (items: SessionItem[]) => groupTimeline({
  provider: "codex", threadId: "thread-1", mode: "default", executionPermission: "readOnly", busy: true, error: null, approvals: [], pendingPlan: null, items
});

it("merges tools across empty reasoning without changing the source items", () => {
  for (const status of ["inProgress", "completed", "failed", "interrupted", undefined]) {
    for (const summary of [undefined, [], ["  "], [{ text: "" }], [{ text: " \n " }]]) {
      const items = [tool("a"), { id: "r", turnId: "turn-1", type: "reasoning", status, summary }, tool("b")];
      expect(timeline(items)).toEqual([{ kind: "tools", items: [items[0], items[2]] }]);
      expect(items).toHaveLength(3);
    }
  }
});

it("splits tools when a streamed reasoning summary gains visible content", () => {
  const reasoning: SessionItem = { id: "r", turnId: "turn-1", type: "reasoning", status: "inProgress", summary: [] };
  const items = [tool("a"), reasoning, tool("b")];
  expect(timeline(items)).toHaveLength(1);
  reasoning.summary = [{ text: "检查项目" }];
  expect(timeline(items)).toEqual([
    { kind: "tools", items: [items[0]] }, { kind: "item", item: reasoning }, { kind: "tools", items: [items[2]] }
  ]);
  reasoning.status = "completed";
  expect(timeline(items)).toHaveLength(3);
});

it("preserves reply and turn boundaries when empty reasoning is skipped", () => {
  const empty: SessionItem = { id: "r", turnId: "turn-1", type: "reasoning", summary: [] };
  const reply: SessionItem = { id: "reply", turnId: "turn-1", type: "agentMessage", text: "继续检查" };
  expect(timeline([tool("a"), empty, reply, tool("b")])).toEqual([
    { kind: "tools", items: [tool("a")] }, { kind: "item", item: reply }, { kind: "tools", items: [tool("b")] }
  ]);
  expect(timeline([tool("a"), empty, tool("b", "turn-2")])).toEqual([
    { kind: "tools", items: [tool("a")] }, { kind: "tools", items: [tool("b", "turn-2")] }
  ]);
});

it("hides empty reasoning regardless of its status", () => {
  const { container, rerender } = render(<CodexEventCard item={{ id: "r", type: "reasoning", summary: [] }} />);
  expect(container.innerHTML).toBe("");
  for (const status of ["inProgress", "completed", "failed", "interrupted", undefined]) {
    for (const summary of [undefined, [], ["  "], [{ text: "" }]]) {
      rerender(<CodexEventCard item={{ id: "r", type: "reasoning", status, summary }} />);
      expect(container.innerHTML).toBe("");
    }
  }
});

it("shows summaries during streaming and after completion", () => {
  const { rerender } = render(<CodexEventCard item={{ id: "r", type: "reasoning", status: "inProgress", summary: ["检查文件"] }} />);
  expect(screen.getByText("检查文件")).toBeTruthy();
  rerender(<CodexEventCard item={{ id: "r", type: "reasoning", status: "completed", summary: [{ text: "最终摘要" }] }} />);
  expect(screen.getByText("最终摘要")).toBeTruthy();
});

it("filters populated reasoning before grouping without mutating snapshots", () => {
  const items: SessionItem[] = [tool("a"), { id: "r", turnId: "turn-1", type: "reasoning", summary: ["hidden"] }, tool("b"), tool("c", "turn-2")];
  const snapshot = { provider: "codex" as const, threadId: "one", mode: "default" as const, executionPermission: "readOnly" as const, busy: true, error: null, approvals: [], pendingPlan: null, items };
  expect(groupTimeline(snapshot, true)).toEqual([{ kind: "tools", items: [items[0], items[2]] }, { kind: "tools", items: [items[3]] }]);
  expect(groupTimeline(snapshot, false)).toHaveLength(4);
  expect(items[1].summary).toEqual(["hidden"]);
});

it("toggles child reasoning during streaming without hiding replies", () => {
  const member = { name: "child", status: "running", items: [{ id: "r", type: "reasoning", status: "inProgress", summary: ["child reasoning"] }, { id: "reply", type: "agentMessage", text: "reply" }] };
  const { rerender } = render(<TeamMemberTimeline member={member} codeBuddy={false} />);
  expect(screen.getByText("child reasoning")).toBeTruthy();
  rerender(<TeamMemberTimeline member={member} codeBuddy={false} minimalMode />);
  expect(screen.queryByText("child reasoning")).toBeNull();
  expect(screen.getByText("reply")).toBeTruthy();
  member.items[0].summary = ["updated reasoning"];
  rerender(<TeamMemberTimeline member={member} codeBuddy={false} minimalMode />);
  expect(screen.queryByText("updated reasoning")).toBeNull();
  rerender(<TeamMemberTimeline member={member} codeBuddy={false} />);
  expect(screen.getByText("updated reasoning")).toBeTruthy();
});
