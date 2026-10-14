import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { GraphicalTimeline } from "./GraphicalTimeline";
import type { GraphicalSnapshot } from "./types";

const mocks = vi.hoisted(() => ({ markdownRender: vi.fn(), copy: vi.fn() }));
vi.mock("./clipboard", () => ({ copyMobileText: mocks.copy }));
vi.mock("react-markdown", async importOriginal => {
  const original = await importOriginal<typeof import("react-markdown")>();
  return { ...original, default: (props: ComponentProps<typeof original.default>) => {
    mocks.markdownRender(props.children);
    return <original.default {...props} />;
  } };
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("keeps large tool details unmounted through updates and renders the full result on expansion", () => {
  const serialized = vi.fn();
  const payload = "x".repeat(512 * 1024);
  const controller = { expandedGroupId: "tool-0", scrollRef: { current: null } } as unknown as ComponentProps<typeof GraphicalTimeline>["controller"];
  const snapshot: GraphicalSnapshot = {
    threadId: "thread-1", provider: "codex", busy: true, archived: false, error: null,
    mode: "default", nativeMode: null, capabilities: { history: true }, pendingPlan: null, approvals: [], questions: [],
    items: Array.from({ length: 30 }, (_, index) => ({
      id: `tool-${index}`, type: "mcpToolCall", toolName: `Tool ${index}`, status: "completed",
      result: { toJSON() { serialized(); return { payload }; } },
      arguments: { toJSON() { serialized(); return { path: "input.txt" }; } },
      changes: [{ toJSON() { serialized(); return { path: "output.txt" }; } }]
    }))
  };
  const view = render(<GraphicalTimeline snapshot={snapshot} controller={controller} />);
  for (let update = 0; update < 5; update++) {
    view.rerender(<GraphicalTimeline snapshot={{ ...snapshot, items: [...snapshot.items,
      { id: "reply", type: "agentMessage", text: `Increment ${update}` }
    ] }} controller={{ ...controller }} />);
  }
  expect(view.container.querySelectorAll(".graphical-tool summary")).toHaveLength(30);
  expect(view.container.querySelectorAll(".graphical-tool-details")).toHaveLength(0);
  expect(serialized).not.toHaveBeenCalled();

  const tool = view.container.querySelector(".graphical-tool") as HTMLDetailsElement;
  tool.open = true;
  fireEvent(tool, new Event("toggle"));
  expect(view.container.querySelectorAll(".graphical-tool-details")).toHaveLength(1);
  expect(serialized).toHaveBeenCalledTimes(3);
  const blocks = tool.querySelectorAll("pre");
  expect(blocks[0].textContent).toBe(JSON.stringify({ path: "input.txt" }, null, 2));
  expect(blocks[1].textContent).toBe(JSON.stringify({ payload }, null, 2));
  expect(blocks[2].textContent).toBe(JSON.stringify([{ path: "output.txt" }], null, 2));

  tool.open = false;
  fireEvent(tool, new Event("toggle"));
  serialized.mockClear();
  view.rerender(<GraphicalTimeline snapshot={{ ...snapshot }} controller={{ ...controller }} />);
  expect(view.container.querySelectorAll(".graphical-tool-details")).toHaveLength(0);
  expect(serialized).not.toHaveBeenCalled();
});

it("skips unchanged history Markdown on parent updates, refreshes changed messages, and copies code", async () => {
  mocks.copy.mockResolvedValue(undefined);
  const setError = vi.fn();
  const controller = { setError, scrollRef: { current: null } } as unknown as ComponentProps<typeof GraphicalTimeline>["controller"];
  const snapshot: GraphicalSnapshot = {
    threadId: "thread-1", provider: "codex", busy: false, archived: false, error: null,
    mode: "default", nativeMode: null, capabilities: { history: true }, pendingPlan: null, approvals: [], questions: [],
    items: Array.from({ length: 100 }, (_, index) => ({ id: `message-${index}`, type: "agentMessage", text: `Message ${index}\n\n\`\`\`js\nconst value = ${index};\n\`\`\`` }))
  };
  const view = render(<GraphicalTimeline snapshot={snapshot} controller={controller} />);
  expect(mocks.markdownRender).toHaveBeenCalledTimes(100);
  for (let update = 0; update < 5; update++) {
    view.rerender(<GraphicalTimeline snapshot={snapshot} controller={{ ...controller }} />);
  }
  expect(mocks.markdownRender).toHaveBeenCalledTimes(100);

  const changed = { ...snapshot, items: snapshot.items.map((item, index) => index === 0 ? { ...item, text: "Updated\n\n```js\nconst changed = true;\n```" } : item) };
  view.rerender(<GraphicalTimeline snapshot={changed} controller={{ ...controller }} />);
  expect(mocks.markdownRender).toHaveBeenCalledTimes(101);
  expect(screen.getByText("Updated")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "复制代码" })[0]);
  expect(mocks.copy).toHaveBeenCalledWith("const changed = true;");

  mocks.copy.mockRejectedValueOnce(new Error("Clipboard unavailable"));
  fireEvent.click(screen.getAllByRole("button", { name: "复制代码" })[0]);
  await waitFor(() => expect(setError).toHaveBeenCalledWith("Error: Clipboard unavailable"));
});

it.each([100, 300])("only parses %i team messages while both details are open and preserves link actions", async count => {
  mocks.copy.mockResolvedValue(undefined);
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  const setError = vi.fn();
  const controller = { setError, scrollRef: { current: null } } as unknown as ComponentProps<typeof GraphicalTimeline>["controller"];
  const snapshot: GraphicalSnapshot = {
    threadId: "thread-1", provider: "codebuddy", busy: false, archived: false, error: null,
    mode: "default", nativeMode: null, capabilities: { history: true }, pendingPlan: null, approvals: [], questions: [], items: [],
    team: { name: "review", isAutoTeam: false, hasLiveMembers: true, members: [{ name: "tester", status: "idle",
      items: Array.from({ length: count }, (_, index) => ({ id: `member-${index}`, type: "agentMessage",
        text: `Message ${index}\n\n[Website](https://example.com) [Local](file:///test.txt)\n\n` + Array.from({ length: 8 }, (_, block) => `\`\`\`js\nconst value = ${block};\n\`\`\``).join("\n\n") }))
    }] }
  };
  const view = render(<GraphicalTimeline snapshot={snapshot} controller={controller} />);
  const team = view.container.querySelector(".graphical-team") as HTMLDetailsElement;
  const member = team.querySelector("details") as HTMLDetailsElement;
  const toggle = (details: HTMLDetailsElement, expanded: boolean) => {
    details.open = expanded;
    fireEvent(details, new Event("toggle"));
  };
  const update = () => {
    for (let index = 0; index < 2; index++) view.rerender(<GraphicalTimeline snapshot={{ ...snapshot }} controller={{ ...controller }} />);
  };
  update();
  expect(mocks.markdownRender).not.toHaveBeenCalled();
  expect(view.container.querySelectorAll(".hljs")).toHaveLength(0);
  toggle(team, true);
  update();
  expect(mocks.markdownRender).not.toHaveBeenCalled();
  expect(view.container.querySelectorAll(".hljs")).toHaveLength(0);
  toggle(member, true);
  expect(mocks.markdownRender).toHaveBeenCalledTimes(count);
  expect(view.container.querySelectorAll(".hljs")).toHaveLength(count * 8);
  expect(screen.getByText(`Message ${count - 1}`)).toBeTruthy();
  update();
  expect(mocks.markdownRender).toHaveBeenCalledTimes(count);
  fireEvent.click(screen.getAllByText("Website")[0]);
  expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
  fireEvent.click(screen.getAllByText("Local")[0]);
  expect(setError).toHaveBeenCalledWith("手机浏览器仅支持 HTTP(S) 外链。");
  fireEvent.focus(screen.getAllByText("Website")[0]);
  fireEvent.click(screen.getByRole("button", { name: "复制链接地址" }));
  await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith("https://example.com"));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("已复制"));
  toggle(member, false);
  mocks.markdownRender.mockClear();
  update();
  expect(mocks.markdownRender).not.toHaveBeenCalled();
  expect(view.container.querySelectorAll(".hljs")).toHaveLength(0);
  toggle(member, true);
  expect(mocks.markdownRender).toHaveBeenCalledTimes(count);
  toggle(team, false);
  mocks.markdownRender.mockClear();
  update();
  expect(mocks.markdownRender).not.toHaveBeenCalled();
  expect(view.container.querySelectorAll(".hljs")).toHaveLength(0);
  toggle(team, true);
  expect(mocks.markdownRender).toHaveBeenCalledTimes(count);
  open.mockRestore();
}, 20000);
