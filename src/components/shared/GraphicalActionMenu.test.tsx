// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GraphicalActionMenu } from "./GraphicalActionMenu";

afterEach(cleanup);

it("preserves the default layout and excludes unavailable actions from the submenu", () => {
  const { rerender } = render(<GraphicalActionMenu><button data-action="model">模型</button></GraphicalActionMenu>);
  expect(screen.queryByText("其他操作")).toBeNull();
  rerender(<GraphicalActionMenu secondaryActions={["plugins"]}><button data-action="model">模型</button>{false && <button data-action="plugins">插件</button>}</GraphicalActionMenu>);
  expect(screen.queryByText("其他操作")).toBeNull();
  expect(screen.getByText("模型")).toBeTruthy();
});

it("groups fragment children, preserves disabled actions, and invokes the original handler", () => {
  const action = vi.fn();
  render(<GraphicalActionMenu secondaryActions={["plugins", "model"]}>
    <><button data-action="history">历史</button><button data-action="plugins" onClick={action}>插件</button></>
    <button data-action="model" disabled>模型</button>
  </GraphicalActionMenu>);
  expect(screen.queryByText("插件")).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "其他操作" }));
  expect(screen.queryByText("历史")).toBeNull();
  expect((screen.getByText("模型") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText("插件"));
  expect(action).toHaveBeenCalledOnce();
});

it("navigates the submenu with arrows and Escape and restores focus to its entry", () => {
  const close = vi.fn();
  render(<GraphicalActionMenu secondaryActions={["plugins", "model"]} onClose={close}>
    <button data-action="history">历史</button>
    <button data-action="plugins">插件</button><button data-action="model" disabled>模型</button>
  </GraphicalActionMenu>);
  const trigger = screen.getByRole("menuitem", { name: "其他操作" });
  trigger.focus(); fireEvent.keyDown(trigger, { key: "ArrowRight" });
  expect(document.activeElement).toBe(screen.getByText("插件"));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement?.textContent).toContain("返回更多操作");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "其他操作" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

it("supports collecting all actions and returns safely when configuration removes the submenu", () => {
  const children = <button data-action="plugins">插件</button>;
  const { rerender } = render(<GraphicalActionMenu secondaryActions={["plugins"]}>{children}</GraphicalActionMenu>);
  expect(screen.getAllByRole("menuitem")).toHaveLength(1);
  fireEvent.click(screen.getByText("其他操作"));
  rerender(<GraphicalActionMenu secondaryActions={[]}>{children}</GraphicalActionMenu>);
  expect(screen.queryByText("返回更多操作", { exact: false })).toBeNull();
  expect(screen.getByText("插件")).toBeTruthy();
});

it("keeps mobile grouped controls intact and returns using the back button", () => {
  render(<GraphicalActionMenu mobile secondaryActions={["mode"]}>
    <div data-action="mode" role="group" aria-label="会话模式"><button>Plan</button><button disabled>Exec</button></div>
    <label data-action="attachments">添加文件<input type="file" aria-label="添加文件" /></label>
  </GraphicalActionMenu>);
  expect(screen.queryByText("Plan")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "其他操作" }));
  expect(screen.getByRole("group", { name: "会话模式" })).toBeTruthy();
  expect((screen.getByText("Exec") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /返回更多操作/ }));
  expect(screen.getByLabelText("添加文件")).toBeTruthy();
  expect(screen.queryByText("Plan")).toBeNull();
});
