// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexPluginDialog } from "./CodexPluginDialog";

afterEach(cleanup);

it("manages the selected Codex environment and explicit enable scope", async () => {
  const catalog = { environment: "WSL: Ubuntu", installed: [{ name: "review", marketplaceName: "team", enabled: true }],
    available: [{ name: "docs", marketplaceName: "team", installPolicy: "AVAILABLE" }],
    marketplaces: [{ name: "team", path: "/home/me/marketplace" }] };
  const list = vi.fn().mockResolvedValue(catalog);
  const readConfig = vi.fn().mockResolvedValue({ overrides: {} });
  const setEnabled = vi.fn().mockResolvedValue({ overrides: { "review@team": { enabled: false } } });
  const install = vi.fn().mockResolvedValue({ ...catalog, installed: [...catalog.installed, catalog.available[0]], available: [] });
  Object.assign(window, { codexPluginApi: { list, readConfig, setEnabled, install } });
  const onChanged = vi.fn();
  render(<CodexPluginDialog sessionId="wsl-1" onClose={vi.fn()} onChanged={onChanged} />);
  await screen.findByText("WSL: Ubuntu");
  fireEvent.click(screen.getByLabelText("该环境所有项目"));
  await waitFor(() => expect(readConfig).toHaveBeenCalledWith("wsl-1", "user"));
  fireEvent.click(screen.getByRole("button", { name: "停用（所有项目）" }));
  await waitFor(() => expect(setEnabled).toHaveBeenCalledWith("wsl-1", "user", { plugin: "review", marketplace: "team", enabled: false }));
  fireEvent.click(screen.getByRole("button", { name: "安装" }));
  await waitFor(() => expect(install).toHaveBeenCalledWith("wsl-1", "docs", "team"));
  expect(onChanged).toHaveBeenCalledTimes(2);
});
