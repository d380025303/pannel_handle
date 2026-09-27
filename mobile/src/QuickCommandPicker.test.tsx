import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QuickCommandPicker } from "./QuickCommandPicker";

afterEach(cleanup);

it("shows pinned commands first and offers the complete touch list", () => {
  const onSelect = vi.fn(() => true);
  render(<QuickCommandPicker commands={[
    { id: "a", command: "first", mode: "write" },
    { id: "b", command: "pinned", mode: "auto-enter", pinned: true },
    { id: "c", command: "third", mode: "one-time" },
    { id: "d", command: "fourth", mode: "write" }
  ]} onSelect={onSelect} />);
  expect(screen.getByRole("button", { name: "pinned" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "快捷输入 (4)" }));
  const dialog = screen.getByRole("dialog", { name: "快捷输入" });
  expect(within(dialog).getByText("置顶 · 自动执行")).toBeTruthy();
  expect(within(dialog).getByText("一次性")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: /fourth/ }));
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "d" }));
  expect(screen.queryByRole("dialog", { name: "快捷输入" })).toBeNull();
});
