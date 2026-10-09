// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GraphicalMenuSettingsDialog } from "./GraphicalMenuSettingsDialog";

afterEach(cleanup);

it("traps focus, blocks dismissal during saving, and displays a failed save", async () => {
  let reject: (error: Error) => void = () => {};
  const setConfig = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
  Object.defineProperty(window, "terminalApi", { configurable: true, value: {
    getConfig: vi.fn().mockResolvedValue({ graphicalMenuSecondaryActions: {} }), setConfig,
    onGraphicalMenuConfigChanged: () => () => {}
  } });
  const close = vi.fn();
  render(<GraphicalMenuSettingsDialog initialProvider="codex" onClose={close} />);
  const dialog = screen.getByRole("dialog", { name: "更多菜单隐藏配置" });
  const closeButton = screen.getByRole("button", { name: "关闭" });
  expect(document.activeElement).toBe(closeButton);
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "将插件管理收纳到其他操作" })).toHaveProperty("disabled", false));
  fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(screen.getAllByRole("checkbox").at(-1));
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(document.activeElement).toBe(closeButton);
  fireEvent.click(screen.getByRole("checkbox", { name: "将插件管理收纳到其他操作" }));
  expect(closeButton).toHaveProperty("disabled", true);
  fireEvent.keyDown(dialog, { key: "Escape" });
  fireEvent.mouseDown(dialog.parentElement!);
  expect(close).not.toHaveBeenCalled();
  await act(async () => reject(new Error("save failed")));
  expect(screen.getByRole("alert").textContent).toBe("save failed");
  expect(closeButton).toHaveProperty("disabled", false);
  fireEvent.click(closeButton);
  expect(close).toHaveBeenCalledOnce();
});
