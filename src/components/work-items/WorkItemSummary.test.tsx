// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkItemSummary } from "./WorkItemSummary";
import type { WorkItem } from "../../vite-env";

const props = { id: "task", version: 1, name: "巡检", summary: "短摘要", disabled: false, resetKey: "0" };
const result = { id: "task", version: 1, output: "# 完整回复\n\n" + "详细内容".repeat(100) } as WorkItem;
function setup(get = vi.fn(async () => result)) {
  window.workItemApi = { get } as unknown as typeof window.workItemApi;
  return { ...render(<WorkItemSummary {...props} />), get, trigger: screen.getByRole("button", { name: "巡检：查看完整回复" }) };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("loads the original reply on hover and reuses the same version on focus", async () => {
  const { get, trigger } = setup();
  expect(get).not.toHaveBeenCalled();
  fireEvent.mouseEnter(trigger);
  await screen.findByRole("heading", { name: "完整回复" });
  expect(screen.getByText("详细内容".repeat(100))).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.focus(trigger);
  await screen.findByRole("heading", { name: "完整回复" });
  expect(get).toHaveBeenCalledTimes(1);
  fireEvent.scroll(screen.getByRole("dialog"));
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.scroll(document);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows a failure and retries", async () => {
  const get = vi.fn(async () => result).mockRejectedValueOnce(new Error("读取失败"));
  const { trigger } = setup(get);
  fireEvent.click(trigger);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("heading", { name: "完整回复" });
  expect(get).toHaveBeenCalledTimes(2);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("ignores replies after closing and reloads changed versions", async () => {
  let resolve!: (value: WorkItem) => void;
  const get = vi.fn(() => new Promise<WorkItem>(done => { resolve = done; }));
  const { trigger, rerender } = setup(get);
  fireEvent.mouseEnter(trigger);
  expect(screen.getByRole("status")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  await act(async () => resolve(result));
  expect(screen.queryByRole("dialog")).toBeNull();
  get.mockResolvedValue(result);
  fireEvent.mouseEnter(trigger);
  await screen.findByRole("heading", { name: "完整回复" });
  expect(get).toHaveBeenCalledTimes(2);
  rerender(<WorkItemSummary {...props} version={2} />);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(trigger);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  rerender(<WorkItemSummary {...props} version={2} disabled />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps the popup open when moving into it and closes on filter changes", async () => {
  const { trigger, rerender } = setup();
  fireEvent.mouseEnter(trigger);
  await screen.findByRole("heading", { name: "完整回复" });
  fireEvent.mouseLeave(trigger);
  fireEvent.mouseEnter(screen.getByRole("dialog"));
  await act(async () => { await new Promise(done => setTimeout(done, 180)); });
  expect(screen.getByRole("dialog")).toBeTruthy();
  rerender(<WorkItemSummary {...props} resetKey="1" />);
  expect(screen.queryByRole("dialog")).toBeNull();
});
