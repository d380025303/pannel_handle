import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QuickCommandPicker } from "./QuickCommandPicker";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

it("keeps keyboard focus inside the picker and restores the trigger on close", async () => {
  const user = userEvent.setup();
  const toggleCtrl = vi.fn();
  render(<><QuickCommandPicker commands={[
    { id: "a", command: "first" },
    { id: "b", command: "disabled" },
    { id: "c", command: "last" }
  ]} disabled={command => command.id === "b"} onSelect={() => true} />
    <button onClick={toggleCtrl}>Ctrl</button></>);
  const trigger = screen.getByRole("button", { name: "快捷输入 (3)" });
  await user.click(trigger);
  const dialog = screen.getByRole("dialog");
  const close = within(dialog).getByRole("button", { name: "关闭快捷输入" });
  const first = within(dialog).getByRole("button", { name: /first/ });
  const last = within(dialog).getByRole("button", { name: /last/ });
  expect(document.activeElement).toBe(close);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(last);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(first);
  await user.tab();
  expect(document.activeElement).toBe(last);
  await user.tab();
  expect(document.activeElement).toBe(close);
  await user.keyboard("{Enter}");
  expect(toggleCtrl).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);

  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);

  await user.click(trigger);
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /last/ }));
  expect(document.activeElement).toBe(trigger);

  await user.click(trigger);
  fireEvent.click(screen.getByRole("dialog").parentElement!);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

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
