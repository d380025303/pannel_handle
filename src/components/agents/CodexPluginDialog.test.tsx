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
  const setEnabled = vi.fn().mockResolvedValue({ overrides: { "review@team": { enabled: false } }, pluginId: "review@team", enabled: false });
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
  expect((await screen.findByRole("switch", { name: "review 启用" })).getAttribute("aria-checked")).toBe("false");
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

it("shows every session MCP while keeping configuration scoped", async () => {
  const configured = { id: "user:local", provider: "codex", scope: "user", name: "local", enabled: true,
    transport: "stdio", command: "node", args: [], argsMasked: false, cwd: "", url: "", urlMasked: false,
    bearerTokenEnvVar: "", env: [], headers: [] };
  const mcpList = vi.fn().mockImplementation(async ({ scope }) => ({ provider: "codex", scope, path: `${scope}/config.toml`,
    version: "v1", servers: scope === "user" ? [configured] : [] }));
  Object.assign(window, {
    codexPluginApi: { list: vi.fn().mockResolvedValue({ environment: "Windows", installed: [], available: [], marketplaces: [] }),
      readConfig: vi.fn().mockResolvedValue({ overrides: {} }) },
    codexAppServerApi: { listCapabilities: vi.fn().mockResolvedValue({ mcp: [
      { name: "local", status: "connected" }, { name: "plugin-a", status: "connected" }, { name: "plugin-b", status: "notStarted" }
    ], errors: {} }) },
    mcpApi: { list: mcpList }
  });
  const session = { id: "windows-1", type: "windows", runtimeMode: "app-server", agentProvider: "codex", cwd: "C:\\repo" } as TerminalSession;
  render(<I18nProvider locale="zh-CN"><CodexPluginDialog sessionId={session.id} session={session} onClose={vi.fn()} onChanged={vi.fn()} /></I18nProvider>);
  fireEvent.click(await screen.findByRole("tab", { name: "MCP 3" }));
  const runtime = screen.getByRole("region", { name: "当前会话 MCP" });
  expect(runtime.textContent).toContain("local");
  expect(runtime.textContent).toContain("plugin-a");
  expect(runtime.textContent).toContain("plugin-b");
  expect(await screen.findByRole("heading", { name: "local" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "plugin-a" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "项目级" }));
  await waitFor(() => expect(mcpList).toHaveBeenCalledWith({ provider: "codex", scope: "project", sessionId: "windows-1" }));
  expect(screen.getByRole("tab", { name: "MCP 3" })).toBeTruthy();
  expect(runtime.textContent).toContain("plugin-b");
});

it("shows MCP read errors, retries, and clears the prior session count", async () => {
  const listCapabilities = vi.fn()
    .mockRejectedValueOnce(new Error("暂时无法读取"))
    .mockResolvedValueOnce({ mcp: [{ name: "first", status: "connected" }], errors: {} })
    .mockResolvedValueOnce({ mcp: [{ name: "second", status: "connected" }], errors: {} });
  Object.assign(window, {
    codexPluginApi: { list: vi.fn().mockResolvedValue({ environment: "Windows", installed: [], available: [], marketplaces: [] }),
      readConfig: vi.fn().mockResolvedValue({ overrides: {} }) },
    codexAppServerApi: { listCapabilities },
    mcpApi: { list: vi.fn().mockResolvedValue({ provider: "codex", scope: "user", path: "config.toml", version: "v1", servers: [] }) }
  });
  const first = { id: "first", type: "windows", runtimeMode: "app-server", agentProvider: "codex", cwd: "C:\\repo" } as TerminalSession;
  const view = render(<I18nProvider locale="zh-CN"><CodexPluginDialog sessionId="first" session={first} onClose={vi.fn()} onChanged={vi.fn()} /></I18nProvider>);
  fireEvent.click(await screen.findByRole("tab", { name: "MCP …" }));
  expect((await screen.findByRole("alert")).textContent).toContain("暂时无法读取");
  fireEvent.click(screen.getByRole("button", { name: "刷新当前会话 MCP" }));
  expect(await screen.findByRole("tab", { name: "MCP 1" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "当前会话 MCP" }).textContent).toContain("first");
  const second = { ...first, id: "second" } as TerminalSession;
  view.rerender(<I18nProvider locale="zh-CN"><CodexPluginDialog sessionId="second" session={second} onClose={vi.fn()} onChanged={vi.fn()} /></I18nProvider>);
  expect(screen.queryByRole("region", { name: "当前会话 MCP" })?.textContent).not.toContain("first");
  await waitFor(() => expect(listCapabilities).toHaveBeenLastCalledWith("second"));
  expect(await screen.findByText("second")).toBeTruthy();
});

it("shows account plugin names and effective enabled states from the catalog", async () => {
  const installed = [
    { name: "figma", displayName: "Figma", marketplaceName: "openai-curated-remote", enabled: true, source: { type: "remote" } },
    { name: "github", displayName: "GitHub", marketplaceName: "openai-curated-remote", enabled: true },
    { name: "computer-use", displayName: "Computer Use", marketplaceName: "openai-bundled", enabled: false },
    { name: "visualize", displayName: "Visualize", marketplaceName: "openai-bundled", enabled: true }
  ];
  Object.assign(window, { codexPluginApi: { list: vi.fn().mockResolvedValue({ environment: "Windows", installed, available: [], marketplaces: [] }),
    readConfig: vi.fn().mockResolvedValue({ overrides: { "figma@openai-curated-remote": { enabled: false } } }) },
  codexAppServerApi: { listCapabilities: vi.fn().mockResolvedValue({ mcp: [] }) } });
  render(<CodexPluginDialog sessionId="windows-1" onClose={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByRole("tab", { name: "插件 4" })).toBeTruthy();
  expect(screen.getByRole("switch", { name: "Figma 停用" }).getAttribute("aria-checked")).toBe("true");
  expect((screen.getByRole("switch", { name: "Figma 停用" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("官方远程插件请在 Codex 官方插件面板启停")).toBeTruthy();
  expect(await screen.findByText("所选范围的配置与 Codex 实际状态不一致")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "Computer Use 启用" }).getAttribute("aria-checked")).toBe("false");
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索插件" }), { target: { value: "github" } });
  expect(screen.getByText("GitHub")).toBeTruthy();
  expect(screen.queryByText("Visualize")).toBeNull();
});
