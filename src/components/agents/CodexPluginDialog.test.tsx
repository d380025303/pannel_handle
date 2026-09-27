// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexPluginDialog } from "./CodexPluginDialog";
import { I18nProvider } from "../../i18n";
import type { TerminalSession } from "../../vite-env";

afterEach(cleanup);

it("manages the selected Codex environment and explicit enable scope", async () => {
  const catalog = { environment: "WSL: Ubuntu", installed: [{ name: "review", marketplaceName: "team", enabled: true }],
    available: [{ name: "docs", marketplaceName: "team", installPolicy: "AVAILABLE" }],
    marketplaces: [{ name: "team", path: "/home/me/marketplace" }] };
  const list = vi.fn().mockResolvedValue(catalog);
  const readConfig = vi.fn().mockResolvedValue({ overrides: {} });
  const setEnabled = vi.fn().mockResolvedValue({ overrides: { "review@team": { enabled: false } } });
  const install = vi.fn().mockResolvedValue({ ...catalog, installed: [...catalog.installed, catalog.available[0]], available: [] });
  Object.assign(window, { codexPluginApi: { list, readConfig, setEnabled, install },
    codexAppServerApi: { listCapabilities: vi.fn().mockResolvedValue({ mcp: [] }) } });
  const onChanged = vi.fn();
  render(<CodexPluginDialog sessionId="wsl-1" onClose={vi.fn()} onChanged={onChanged} />);
  await screen.findByText(/WSL: Ubuntu/);
  fireEvent.click(screen.getByLabelText("该环境所有项目"));
  await waitFor(() => expect(readConfig).toHaveBeenCalledWith("wsl-1", "user"));
  fireEvent.click(screen.getByRole("switch", { name: "review 停用" }));
  await waitFor(() => expect(setEnabled).toHaveBeenCalledWith("wsl-1", "user", { plugin: "review", marketplace: "team", enabled: false }));
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  fireEvent.click(screen.getByRole("button", { name: "安装" }));
  await waitFor(() => expect(install).toHaveBeenCalledWith("wsl-1", "docs", "team"));
  expect(onChanged).toHaveBeenCalledTimes(2);
});

it("opens MCP management for the current graphical session", async () => {
  const mcpList = vi.fn().mockResolvedValue({ provider: "codex", scope: "user", path: "~/.codex/config.toml", version: "v1", servers: [] });
  Object.assign(window, {
    codexPluginApi: { list: vi.fn().mockResolvedValue({ environment: "SSH: server", installed: [], available: [], marketplaces: [] }),
      readConfig: vi.fn().mockResolvedValue({ overrides: {} }) },
    codexAppServerApi: { listCapabilities: vi.fn().mockResolvedValue({ mcp: [{ name: "remote", status: "connected" }] }) },
    mcpApi: { list: mcpList }
  });
  const session = { id: "ssh-1", type: "ssh", agentLocation: "remote", runtimeMode: "app-server",
    agentProvider: "codex", cwd: "/srv/app" } as TerminalSession;
  render(<I18nProvider locale="zh-CN"><CodexPluginDialog sessionId="ssh-1" session={session} onClose={vi.fn()} onChanged={vi.fn()} /></I18nProvider>);
  fireEvent.click(await screen.findByRole("tab", { name: "MCP 1" }));
  await waitFor(() => expect(mcpList).toHaveBeenCalledWith({ provider: "codex", scope: "user", sessionId: "ssh-1" }));
  expect(screen.queryByRole("tab", { name: "CodeBuddy" })).toBeNull();
  expect(screen.getByRole("tab", { name: "项目级" })).toBeTruthy();
});

it("shows account plugin names and effective enabled states from the catalog", async () => {
  const installed = [
    { name: "figma", displayName: "Figma", marketplaceName: "openai-curated-remote", enabled: true },
    { name: "github", displayName: "GitHub", marketplaceName: "openai-curated-remote", enabled: true },
    { name: "computer-use", displayName: "Computer Use", marketplaceName: "openai-bundled", enabled: false },
    { name: "visualize", displayName: "Visualize", marketplaceName: "openai-bundled", enabled: true }
  ];
  Object.assign(window, { codexPluginApi: { list: vi.fn().mockResolvedValue({ environment: "Windows", installed, available: [], marketplaces: [] }),
    readConfig: vi.fn().mockResolvedValue({ overrides: {} }) },
  codexAppServerApi: { listCapabilities: vi.fn().mockResolvedValue({ mcp: [] }) } });
  render(<CodexPluginDialog sessionId="windows-1" onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByRole("tab", { name: "插件 4" })).toBeTruthy();
  expect(screen.getByRole("switch", { name: "Figma 停用" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("switch", { name: "Computer Use 启用" }).getAttribute("aria-checked")).toBe("false");
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索插件" }), { target: { value: "github" } });
  expect(screen.getByText("GitHub")).toBeTruthy();
  expect(screen.queryByText("Visualize")).toBeNull();
});
