// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GraphicalMenuSettings } from "./GraphicalMenuSettings";
import type { GraphicalMenuConfig } from "../../utils/graphicalMenu";

afterEach(cleanup);

function setup(config: GraphicalMenuConfig = {}) {
  let changed: (config: GraphicalMenuConfig) => void = () => {};
  const getConfig = vi.fn().mockResolvedValue({ graphicalMenuSecondaryActions: config });
  const setConfig = vi.fn().mockImplementation(async partial => partial);
  const unsubscribe = vi.fn();
  Object.defineProperty(window, "terminalApi", { configurable: true, value: {
    getConfig, setConfig, onGraphicalMenuConfigChanged: (callback: typeof changed) => { changed = callback; return unsubscribe; }
  } });
  const view = render(<GraphicalMenuSettings />);
  return { ...view, getConfig, setConfig, unsubscribe, emit: (value: GraphicalMenuConfig) => act(() => changed(value)) };
}

it("saves per Agent settings, marks platform specific actions, and resets only the selected Agent", async () => {
  const { setConfig } = setup({ opencode: ["login"] });
  const checkbox = await screen.findByRole("checkbox", { name: "将插件管理收纳到其他操作" });
  await waitFor(() => expect((checkbox as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(checkbox);
  await waitFor(() => expect((checkbox as HTMLInputElement).checked).toBe(true));
  expect(setConfig.mock.calls[0][0].graphicalMenuSecondaryActions).toMatchObject({ codex: ["plugins"], opencode: ["login"] });
  expect(screen.getAllByText("仅移动端菜单").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "恢复当前 Agent 默认" }));
  await waitFor(() => expect((checkbox as HTMLInputElement).checked).toBe(false));
  expect(setConfig.mock.calls[1][0].graphicalMenuSecondaryActions).toMatchObject({ codex: [], opencode: ["login"] });
  fireEvent.change(screen.getByRole("combobox", { name: "配置 Agent" }), { target: { value: "opencode" } });
  expect((screen.getByRole("checkbox", { name: "将登录 OpenCode收纳到其他操作" }) as HTMLInputElement).checked).toBe(true);
});

it("retains saved selections on failure and accepts configuration broadcasts", async () => {
  const { setConfig, emit, unmount, unsubscribe } = setup();
  const checkbox = screen.getByRole("checkbox", { name: "将插件管理收纳到其他操作" }) as HTMLInputElement;
  await waitFor(() => expect(checkbox.disabled).toBe(false));
  setConfig.mockRejectedValueOnce(new Error("disk unavailable"));
  fireEvent.click(checkbox);
  await screen.findByText("disk unavailable");
  expect(checkbox.checked).toBe(false);
  emit({ codex: ["plugins"] });
  expect(checkbox.checked).toBe(true);
  unmount(); expect(unsubscribe).toHaveBeenCalledOnce();
});

it("does not let a stale initial read overwrite a newer host broadcast", async () => {
  const { getConfig, emit } = setup();
  let resolve: (value: unknown) => void = () => {};
  getConfig.mockReturnValue(new Promise(done => { resolve = done; }));
  await waitFor(() => expect(getConfig).toHaveBeenCalledOnce());
  emit({ codex: ["plugins"] });
  await act(async () => resolve({ graphicalMenuSecondaryActions: {} }));
  expect((screen.getByRole("checkbox", { name: "将插件管理收纳到其他操作" }) as HTMLInputElement).checked).toBe(true);
});
