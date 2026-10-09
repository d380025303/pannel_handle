// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexAppServerSnapshot } from "../../vite-env";
import { DiagnosticCard, CodexEventCard, groupTimeline, TeamMemberTimeline, ToolGroup } from "./GraphicalTimeline";

afterEach(cleanup);

it("renders activity lifecycle separately from completed collaboration calls and all targets", () => {
  const { rerender } = render(<CodexEventCard item={{ id: "a", type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "/root/scout" }} />);
  expect(screen.getByText("子 Agent · 开始任务")).toBeTruthy();
  expect(screen.queryByText(/未识别/)).toBeNull();
  rerender(<CodexEventCard item={{ id: "a", type: "subAgentActivity", kind: "completed", agentThreadId: "child" }} />);
  expect(screen.getByText("子 Agent · 任务完成")).toBeTruthy();
  rerender(<CodexEventCard item={{ id: "wait", type: "collabAgentToolCall", tool: "wait", status: "completed", receiverThreadIds: ["a", "b"], agentsStates: { a: { status: "running" }, b: { status: "completed", message: "member result" } }, prompt: "inspect task" }} />);
  expect(screen.getByText(/调用已完成/)).toBeTruthy();
  expect(screen.getByText("目标线程：a · 运行中")).toBeTruthy();
  expect(screen.getByText("目标线程：b · 已完成")).toBeTruthy();
  expect(screen.getByText("member result")).toBeTruthy();
});

it("renders OpenCode structured results only on expansion and keeps expansion on updates", () => {
  const item = { id: "a", type: "toolCall", toolName: "Edit", arguments: false, result: 0,
    output: "unique output", locations: [{ path: "/work/a", line: 4 }], toolContent: [
      { type: "content", content: { type: "text", text: "unique output" } },
      { type: "diff", path: "/work/a", oldText: "before", newText: "after" },
      { type: "content", content: { type: "image", mimeType: "image/png", data: "aGVsbG8=" } },
      { type: "content", content: { type: "resource_link", name: "a.txt", uri: "file:///work/a.txt" } }
    ] };
  const { rerender } = render(<ToolGroup items={[item]} expanded onToggle={() => {}} />);
  expect(screen.queryByText("unique output")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
  expect(screen.getAllByText("unique output")).toHaveLength(1);
  expect(screen.getByText("false")).toBeTruthy();
  expect(screen.getByText("0")).toBeTruthy();
  expect(screen.getByText("/work/a:4")).toBeTruthy();
  expect(screen.getByAltText("工具返回的图片")).toBeTruthy();
  expect(screen.getByText("a.txt")).toBeTruthy();
  fireEvent.click(screen.getByText("/work/a", { selector: "summary" }));
  rerender(<ToolGroup items={[{ ...item, status: "completed" }]} expanded onToggle={() => {}} />);
  expect(screen.getByText("before").closest("details")?.open).toBe(true);
  expect(screen.getByText("after")).toBeTruthy();
});

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

it("closes a configuration warning across remounts without changing details", () => {
  const event = { id: "close-test", kind: "configWarning", at: Date.now(), turnId: null, payload: { summary: "close warning" } };
  const view = render(<DiagnosticCard event={event} sessionId="close-session" />);
  const details = view.container.querySelector("details")!;
  fireEvent.click(screen.getByRole("button", { name: "关闭配置警告" }));
  expect(details.open).toBe(false);
  expect(screen.queryByText("close warning")).toBeNull();
  view.unmount();
  render(<DiagnosticCard event={event} sessionId="close-session" />);
  expect(screen.queryByText("close warning")).toBeNull();
  expect(screen.queryByText("不再提示")).toBeNull();
});

it("suppresses equal warnings only in the selected template and allows retry after failure", async () => {
  const callbacks = new Set<(payload: { templateId: string; ignored: string[] }) => void>();
  const ignoreConfigWarning = vi.fn().mockRejectedValueOnce(new Error("disk unavailable")).mockImplementation(async (templateId, fingerprint) => {
    for (const callback of callbacks) callback({ templateId, ignored: [fingerprint] });
    return [fingerprint];
  });
  const previous = window.terminalApi;
  window.terminalApi = { getIgnoredConfigWarnings: async () => [], ignoreConfigWarning,
    onConfigWarningsChanged: (callback: (payload: { templateId: string; ignored: string[] }) => void) => { callbacks.add(callback); return () => { callbacks.delete(callback); }; }
  } as unknown as typeof window.terminalApi;
  const event = { id: "ignore-test", kind: "configWarning", at: Date.now(), turnId: null, payload: { summary: "same warning" } };
  try {
    const view = render(<><DiagnosticCard event={event} sessionId="a1" templateId="template-a" /><DiagnosticCard event={{ ...event, id: "second" }} sessionId="a2" templateId="template-a" /><DiagnosticCard event={event} sessionId="b" templateId="template-b" /></>);
    await waitFor(() => expect(callbacks.size).toBe(3));
    fireEvent.click(screen.getAllByRole("button", { name: "不再提示" })[0]);
    await screen.findByRole("alert");
    expect(screen.getAllByText("same warning")).toHaveLength(3);
    expect(view.container.querySelector("details")!.open).toBe(false);
    fireEvent.click(screen.getAllByRole("button", { name: "不再提示" })[0]);
    await waitFor(() => expect(screen.getAllByText("same warning")).toHaveLength(1));
    view.unmount();
    render(<DiagnosticCard event={{ ...event, payload: { summary: "different warning" } }} sessionId="a3" templateId="template-a" />);
    expect(screen.getByText("different warning")).toBeTruthy();
  } finally { cleanup(); window.terminalApi = previous; }
});

 it("renders Codex activities with optional details and preserves event filtering", () => {
  const sleep = { id: "sleep", type: "sleep", status: "completed", durationMs: 1500 };
  const image = { id: "image", type: "imageGeneration", status: "failed", savedPath: "C:/result.png" };
  const { rerender } = render(<CodexEventCard item={sleep} />);
  expect(screen.getByText("等待时长：1.5 秒")).toBeTruthy();
  expect(screen.getByText("已完成")).toBeTruthy();
  rerender(<CodexEventCard item={image} />);
  expect(screen.getByText("图片生成")).toBeTruthy();
  expect(screen.getByText("失败")).toBeTruthy();
  expect(screen.getByText("结果路径：C:/result.png")).toBeTruthy();
  rerender(<CodexEventCard item={{ id: "image", type: "imageGeneration" }} />);
  expect(screen.queryByText(/结果路径/)).toBeNull();
  expect(screen.queryByText(/未识别/)).toBeNull();
  expect(timeline([sleep, image]).map(entry => entry.kind)).toEqual(["item", "item"]);
  const snapshot = { provider: "opencode", items: [sleep, image], diagnostics: [] } as unknown as CodexAppServerSnapshot;
  expect(groupTimeline(snapshot)).toEqual([]);
});
