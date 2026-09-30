// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodeBuddyPluginDialog } from "./CodeBuddyPluginDialog";

afterEach(cleanup);

it("installs into the selected scope and offers a retry when activation fails", async () => {
  const catalog = { installed: [], available: [{ name: "formatter", marketplaceName: "example" }],
    marketplaces: [], errors: [], environment: "Windows" };
  const install = vi.fn().mockResolvedValue({ ...catalog, reloadError: "服务暂不可用" });
  const reload = vi.fn().mockResolvedValue(catalog);
  Object.assign(window, { codeBuddyPluginApi: { list: vi.fn().mockResolvedValue(catalog), install, reload } });
  render(<CodeBuddyPluginDialog sessionId="session" onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("tab", { name: "可安装" }));
  fireEvent.click(screen.getByLabelText("项目"));
  fireEvent.click(screen.getByRole("button", { name: "安装" }));
  await waitFor(() => expect(install).toHaveBeenCalledWith("session", "formatter", "example", "project"));
  expect(await screen.findByText(/已安装到项目范围.*重载失败/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重载插件" }));
  await waitFor(() => expect(reload).toHaveBeenCalledWith("session"));
});
