// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexPluginDialog } from "./CodexPluginDialog";
import { I18nProvider } from "../../i18n";
import type { TerminalSession } from "../../vite-env";

afterEach(cleanup);

it("wraps keyboard focus in both tabs while skipping unavailable controls", async () => {
  Object.assign(window, {
    codexPluginApi: { list: vi.fn().mockResolvedValue({ installed: [{ name: "tools", marketplaceName: "team" }], available: [], marketplaces: [] }),
      readConfig: vi.fn().mockResolvedValue({ overrides: {} }) },
    codexAppServerApi: { listCapabilities: vi.fn().mockResolvedValue({ mcp: [] }) }
  });
  const onClose = vi.fn();
  render(<CodexPluginDialog sessionId="focus" onClose={onClose} onChanged={vi.fn()} />);
  const uninstall = await screen.findByRole("button", { name: "卸载" });
  await waitFor(() => expect((uninstall as HTMLButtonElement).disabled).toBe(false));
  const dialog = screen.getByRole("dialog", { name: "Codex 插件管理" });
  const close = screen.getByRole("button", { name: "关闭插件管理" });
  // jsdom has no layout; provide visible rectangles for the real dialog controls.
  dialog.querySelectorAll<HTMLElement>("button, input").forEach(element => {
    vi.spyOn(element, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  });
  const hidden = document.createElement("button");
  hidden.hidden = true;
  vi.spyOn(hidden, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  const disabled = document.createElement("button");
  disabled.disabled = true;
  dialog.append(hidden, disabled);
  uninstall.focus();
  fireEvent.keyDown(uninstall, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(uninstall);
  fireEvent.click(screen.getByRole("tab", { name: "MCP 0" }));
  const last = screen.getByRole("button", { name: "重载 MCP" });
  dialog.querySelectorAll<HTMLElement>("button").forEach(element => {
    vi.spyOn(element, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  });
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});

it("opens an installed plugin detail from its existing list", async () => {
  const readPluginDetail = vi.fn().mockResolvedValue({ name: "design", marketplaceName: "official",
    description: "Design tools", version: "1.0", source: { type: "remote" }, installed: true, enabled: true,
    shareUrl: "https://example.com/design", remotePluginId: null,
    skills: [{ name: "disabled-skill", enabled: true }], apps: [], mcpServers: ["files"] });
  Object.assign(window, {
    codexPluginApi: { list: vi.fn().mockResolvedValue({ environment: "Windows", installed: [
      { name: "design", marketplaceName: "official", enabled: true }], available: [], marketplaces: [] }),
      readConfig: vi.fn().mockResolvedValue({ overrides: {} }) },
    codexAppServerApi: { listCapabilities: vi.fn().mockResolvedValue({ mcp: [], errors: {} }), readPluginDetail }
  });
  const onClose = vi.fn();
  render(<CodexPluginDialog sessionId="run-1" onClose={onClose} onChanged={vi.fn()} />);
  const trigger = await screen.findByRole("button", { name: "详情" });
  trigger.focus();
  fireEvent.click(trigger);
  const detail = await screen.findByRole("dialog", { name: "design 详情" });
  const close = screen.getByRole("button", { name: "关闭详情" });
  expect(document.activeElement).toBe(close);
  const last = await screen.findByRole("button", { name: "查看插件页面" });
  detail.querySelectorAll<HTMLElement>("button").forEach(element => {
    vi.spyOn(element, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  });
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "design 详情" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Codex 插件管理" })).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
  expect(document.activeElement).toBe(trigger);
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  expect(readPluginDetail).toHaveBeenCalledWith("run-1", "design", "official");
});

it("shows MCP startup failures and opens OAuth in the external browser", async () => {
  let changed: ((payload: { id: string; snapshot: unknown }) => void) | undefined;
  const loginMcpServer = vi.fn().mockResolvedValue({ authorizationUrl: "https://auth.example.com/connect" });
  const open = vi.fn().mockResolvedValue(undefined);
  Object.assign(window, {
    codexPluginApi: { list: vi.fn().mockResolvedValue({ environment: "Windows", installed: [], available: [], marketplaces: [] }),
      readConfig: vi.fn().mockResolvedValue({ overrides: {} }) },
    codexAppServerApi: { listCapabilities: vi.fn().mockResolvedValue({ mcp: [{ name: "files", status: "connected",
      authStatus: "supported", toolsError: null, tools: [] }], errors: {} }),
    snapshot: vi.fn().mockResolvedValue({}), loginMcpServer, reloadMcpServers: vi.fn(),
    onChanged: vi.fn(callback => { changed = callback; return () => { changed = undefined; }; }) },
    externalLinkApi: { open }
  });
  render(<CodexPluginDialog sessionId="run-1" onClose={vi.fn()} onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole("tab", { name: "MCP 1" }));
  act(() => changed?.({ id: "run-1", snapshot: { mcpRuntime: [{ name: "files", status: "failed",
    error: "token expired", failureReason: "reauthenticationRequired" }] } }));
  expect(screen.getByText("token expired")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
  await waitFor(() => expect(loginMcpServer).toHaveBeenCalledWith("run-1", "files"));
  await waitFor(() => expect(open).toHaveBeenCalledWith("https://auth.example.com/connect"));
});

it("reloads after saving MCP config and keeps a failed reload retryable", async () => {
  const reloadMcpServers = vi.fn().mockRejectedValueOnce(new Error("reload unavailable")).mockResolvedValue(undefined);
  const savedServer = { id: "user:files", provider: "codex", scope: "user", name: "files", enabled: true,
    transport: "stdio", command: "node", args: [], argsMasked: false, cwd: "", url: "", urlMasked: false,
    bearerTokenEnvVar: "", env: [], headers: [] };
  const save = vi.fn().mockResolvedValue({ status: "saved", serverName: "files", document: {
    provider: "codex", scope: "user", path: "config.toml", version: "v2", servers: [savedServer] } });
  Object.assign(window, {
    codexPluginApi: { list: vi.fn().mockResolvedValue({ environment: "Windows", installed: [], available: [], marketplaces: [] }),
      readConfig: vi.fn().mockResolvedValue({ overrides: {} }) },
    codexAppServerApi: { listCapabilities: vi.fn().mockResolvedValue({ mcp: [], errors: {} }), reloadMcpServers },
    mcpApi: { list: vi.fn().mockResolvedValue({ provider: "codex", scope: "user", path: "config.toml", version: "v1", servers: [] }), save }
  });
  const session = { id: "run-1", type: "windows", runtimeMode: "app-server", agentProvider: "codex", cwd: "C:\\project" } as TerminalSession;
  render(<I18nProvider locale="zh-CN"><CodexPluginDialog sessionId="run-1" session={session} onClose={vi.fn()} onChanged={vi.fn()} /></I18nProvider>);
  fireEvent.click(await screen.findByRole("tab", { name: "MCP 0" }));
  fireEvent.click(await screen.findByRole("button", { name: "新增 MCP 服务" }));
  fireEvent.change(screen.getByLabelText("服务名称"), { target: { value: "files" } });
  fireEvent.change(screen.getByLabelText("启动命令"), { target: { value: "node" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(reloadMcpServers).toHaveBeenCalledWith("run-1"));
  expect(await screen.findByText(/配置已保存，但当前会话重载失败：reload unavailable/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重载 MCP" }));
  await waitFor(() => expect(reloadMcpServers).toHaveBeenCalledTimes(2));
});

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
