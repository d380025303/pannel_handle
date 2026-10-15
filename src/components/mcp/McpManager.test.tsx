// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { McpDocument, McpServerSummary, TerminalSession } from "../../vite-env";
import { McpManager } from "./McpManager";

const codexServer: McpServerSummary = {
  id: "user:local-tools",
  provider: "codex",
  scope: "user",
  name: "local-tools",
  enabled: true,
  transport: "stdio",
  command: "npx",
  args: ["-y", "example-mcp"],
  argsMasked: false,
  cwd: "",
  url: "",
  urlMasked: false,
  bearerTokenEnvVar: "",
  env: [{ key: "TOKEN", value: "", masked: true, hasValue: true }],
  headers: [],
  startupTimeoutSec: 10,
  toolTimeoutSec: undefined
};

const documentFor = (provider = "codex", scope = "user"): McpDocument => ({
  provider: provider as McpDocument["provider"],
  scope: scope as McpDocument["scope"],
  path: provider === "codex" ? "C:\\Users\\tester\\.codex\\config.toml" : "C:\\Users\\tester\\.codebuddy.json",
  version: `${provider}-${scope}-v1`,
  servers: provider === "codex" && scope === "user" ? [codexServer] : []
});

const windowsSession = { id: "session-1", type: "windows", cwd: "C:\\repo", title: "Repo" } as TerminalSession;
const list = vi.fn();
const reveal = vi.fn();
const save = vi.fn();
const remove = vi.fn();
const copy = vi.fn();

function renderManager(session: TerminalSession | undefined = windowsSession, onDirtyChange = vi.fn()) {
  return render(
    <I18nProvider locale="zh-CN">
      <McpManager session={session} onDirtyChange={onDirtyChange} onRegisterSave={() => undefined} />
    </I18nProvider>
  );
}

describe("McpManager", () => {
  beforeEach(() => {
    list.mockReset();
    reveal.mockReset();
    save.mockReset();
    remove.mockReset();
    copy.mockReset();
    list.mockImplementation(async ({ provider, scope }) => documentFor(provider, scope));
    reveal.mockResolvedValue({ status: "revealed", value: "top-secret" });
    save.mockImplementation(async ({ draft }) => ({
      status: "saved",
      serverName: draft.name,
      document: { ...documentFor("codex", "user"), version: "v2", servers: [{ ...codexServer, ...draft, id: `user:${draft.name}` }] }
    }));
    remove.mockResolvedValue({ status: "removed", document: { ...documentFor(), version: "v2", servers: [] } });
    copy.mockImplementation(async ({ source, name }) => ({ status: "copied", serverName: name, permissionsCopied: false,
      document: { ...documentFor(source.provider === "codex" ? "opencode" : "codex", source.scope),
        servers: [{ ...codexServer, provider: source.provider === "codex" ? "opencode" : "codex", name }] } }));
    Object.defineProperty(window, "mcpApi", { configurable: true, value: { list, reveal, save, remove, copy } });
    Object.defineProperty(window, "sessionStatusMcpApi", { configurable: true, value: {
      get: vi.fn().mockResolvedValue({ enabled: false, running: false, url: "http://127.0.0.1:43124/mcp", error: "" }),
      setEnabled: vi.fn().mockResolvedValue({ enabled: true, running: true, url: "http://127.0.0.1:43124/mcp", error: "" }),
      revealToken: vi.fn().mockResolvedValue("secret"), onChanged: vi.fn().mockReturnValue(() => undefined)
    } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads Codex servers, keeps secrets masked, and reveals on demand", async () => {
    const onDirtyChange = vi.fn();
    renderManager(windowsSession, onDirtyChange);

    expect(await screen.findByRole("heading", { name: "local-tools" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "返回终端" })).toBeNull();
    const masked = screen.getByDisplayValue("••••••••") as HTMLInputElement;
    expect(masked.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "揭示敏感值" }));

    await waitFor(() => expect(reveal).toHaveBeenCalledWith(expect.objectContaining({ name: "local-tools", field: "env", key: "TOKEN" })));
    expect(await screen.findByDisplayValue("top-secret")).toBeTruthy();
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it.each([
    ["stdio", "环境变量名", "env", "API_KEY"],
    ["http", "Header 名称", "headers", "X-API-Key"]
  ])("keeps %s row focus and identity while editing and deleting siblings", async (transport, label, field, name) => {
    const user = userEvent.setup();
    renderManager();
    await screen.findByRole("heading", { name: "local-tools" });
    await user.click(screen.getByRole("button", { name: "新增 MCP 服务" }));
    await user.type(screen.getByLabelText("服务名称"), "focus-test");
    await user.selectOptions(screen.getByLabelText("传输方式"), transport);
    const add = document.querySelector(".mcp-add-row") as HTMLButtonElement;
    await user.click(add);
    await user.click(add);
    const [first, target] = screen.getAllByLabelText(label) as HTMLInputElement[];
    await user.type(first, "OTHER");
    await user.click(target);
    // Keyboard input follows focus, so a remount after the first character fails this check.
    await user.keyboard(name);
    expect(target.value).toBe(name);
    expect(document.activeElement).toBe(target);
    await user.keyboard("{ArrowLeft}{Backspace}Z");
    const edited = name.slice(0, -2) + "Z" + name.slice(-1);
    expect(target.value).toBe(edited);
    expect(target.selectionStart).toBe(name.length - 1);
    expect(document.activeElement).toBe(target);
    // Remove the preceding row without moving focus to its button.
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    expect(screen.getByLabelText(label)).toBe(target);
    expect(document.activeElement).toBe(target);
    expect(target.selectionStart).toBe(name.length - 1);
    await user.keyboard("{End}_NEXT");
    expect(target.value).toBe(edited + "_NEXT");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].draft[field]).toEqual([
      { key: edited + "_NEXT", value: "", masked: false, hasValue: false }
    ]);
  });

  it("preserves Enter while editing arguments and saves separate items without empty lines", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    renderManager(windowsSession, onDirtyChange);
    await screen.findByRole("heading", { name: "local-tools" });
    const args = screen.getByPlaceholderText("每行一个参数") as HTMLTextAreaElement;
    await user.click(args);
    await user.keyboard("{Control>}{End}{/Control}{Enter}");
    expect(args.value).toBe("-y\nexample-mcp\n");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("--help{Enter}{Enter}");
    expect(args.value).toBe("-y\nexample-mcp\n--help\n\n");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ args: ["-y", "example-mcp", "--help"] })
    })));
    await screen.findByText("MCP 配置已保存。");
    const savedDocument = (await save.mock.results[0].value).document;
    list.mockResolvedValueOnce(savedDocument);
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(args.value).toBe("-y\nexample-mcp\n--help"));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("switches CodeBuddy project scopes using the active Windows session", async () => {
    renderManager();
    await screen.findByRole("heading", { name: "local-tools" });
    fireEvent.click(screen.getByRole("tab", { name: "CodeBuddy" }));
    await waitFor(() => expect(list).toHaveBeenCalledWith({ provider: "codebuddy", scope: "user" }));
    fireEvent.click(screen.getByRole("tab", { name: "项目私有" }));
    await waitFor(() => expect(list).toHaveBeenCalledWith({ provider: "codebuddy", scope: "project-local", sessionId: "session-1" }));
    fireEvent.click(screen.getByRole("tab", { name: "项目共享" }));
    await waitFor(() => expect(list).toHaveBeenCalledWith({ provider: "codebuddy", scope: "project", sessionId: "session-1" }));
    expect(await screen.findByText(/修改当前工作目录/)).toBeTruthy();
  });

  it("creates and saves a structured stdio server", async () => {
    renderManager();
    await screen.findByRole("heading", { name: "local-tools" });
    fireEvent.click(screen.getByRole("button", { name: "新增 MCP 服务" }));
    fireEvent.change(screen.getByLabelText("服务名称"), { target: { value: "new-server" } });
    fireEvent.change(screen.getByLabelText("启动命令"), { target: { value: "node" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      scope: "user",
      draft: expect.objectContaining({ name: "new-server", command: "node", transport: "stdio" })
    })));
    expect(await screen.findByText("MCP 配置已保存。")).toBeTruthy();
  });

  it.each(["project-local", "project"] as const)("reads and saves SSH local CodeBuddy %s configuration using the session target", async scope => {
    const session = { ...windowsSession, type: "ssh", agentLocation: "local", agentProvider: "codebuddy", cwd: "/srv/app" } as TerminalSession;
    save.mockImplementationOnce(async ({ draft }) => ({
      status: "saved", serverName: draft.name,
      document: { ...documentFor("codebuddy", scope), servers: [{ ...codexServer, ...draft, provider: "codebuddy", scope }] }
    }));
    renderManager(session);
    await screen.findByRole("heading", { name: "local-tools" });
    fireEvent.click(screen.getByRole("tab", { name: "CodeBuddy" }));
    await waitFor(() => expect(list).toHaveBeenCalledWith({ provider: "codebuddy", scope: "user" }));
    const projectTab = screen.getByRole("tab", { name: scope === "project-local" ? "项目私有" : "项目共享" }) as HTMLButtonElement;
    expect(projectTab.disabled).toBe(false);
    fireEvent.click(projectTab);
    await waitFor(() => expect(list).toHaveBeenCalledWith({ provider: "codebuddy", scope, sessionId: session.id }));
    fireEvent.click(screen.getByRole("button", { name: "新增 MCP 服务" }));
    fireEvent.change(screen.getByLabelText("服务名称"), { target: { value: "ssh-local-tools" } });
    fireEvent.change(screen.getByLabelText("启动命令"), { target: { value: "node" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codebuddy", scope, sessionId: session.id,
      expectedVersion: `codebuddy-${scope}-v1`,
      draft: expect.objectContaining({ name: "ssh-local-tools", command: "node" })
    })));
    expect(await screen.findByText("MCP 配置已保存。")).toBeTruthy();
  });

  it.each(["wsl", "ssh"] as const)("disables project scopes for remote %s sessions", async type => {
    renderManager({ ...windowsSession, type, agentLocation: "remote", agentProvider: "codebuddy", cwd: "/srv/app" } as TerminalSession);
    await screen.findByRole("heading", { name: "local-tools" });
    expect((screen.getByRole("tab", { name: "项目级" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "CodeBuddy" }));
    await waitFor(() => expect(list).toHaveBeenCalledWith({ provider: "codebuddy", scope: "user" }));
    for (const name of ["项目私有", "项目共享"]) {
      const tab = screen.getByRole("tab", { name }) as HTMLButtonElement;
      expect(tab.disabled).toBe(true);
      fireEvent.click(tab);
    }
    expect(list.mock.calls.every(([target]) => target.scope === "user")).toBe(true);
  });

  it("copies a selected Codex server to OpenCode and switches to the destination", async () => {
    renderManager();
    await screen.findByRole("heading", { name: "local-tools" });
    fireEvent.click(screen.getByRole("button", { name: "复制到 OpenCode" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith({
      source: { provider: "codex", scope: "user" }, name: "local-tools",
      expectedSourceVersion: "codex-user-v1", expectedDestinationVersion: "opencode-user-v1"
    }));
    expect((screen.getByRole("tab", { name: "OpenCode" }) as HTMLButtonElement).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText(/已复制到 OpenCode/)).toBeTruthy();
  });

  it.each(["ssh", "wsl"])("explains unsupported copying in an embedded %s Codex session", async type => {
    render(<I18nProvider locale="zh-CN"><McpManager embeddedCodex
      session={{ ...windowsSession, type, runtimeMode: "app-server", agentLocation: "remote", cwd: "/srv/app" } as TerminalSession}
      onDirtyChange={() => undefined} onRegisterSave={() => undefined} /></I18nProvider>);
    await screen.findByRole("heading", { name: "local-tools" });
    expect(screen.getByText("暂不支持复制远程 Codex MCP 配置（SSH/WSL）。")).toBeTruthy();
    expect(list).toHaveBeenCalledWith({ provider: "codex", scope: "user", sessionId: "session-1" });
    const button = screen.getByRole("button", { name: "复制到 OpenCode" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(copy).not.toHaveBeenCalled();
    expect(list.mock.calls.some(([target]) => target.provider === "opencode")).toBe(false);
  });

  it("reports when tool permissions are copied with the server", async () => {
    copy.mockImplementationOnce(async ({ name }) => ({ status: "copied", serverName: name, permissionsCopied: true,
      document: { ...documentFor("opencode", "user"), servers: [{ ...codexServer, provider: "opencode", name }] } }));
    renderManager();
    await screen.findByRole("heading", { name: "local-tools" });
    fireEvent.click(screen.getByRole("button", { name: "复制到 OpenCode" }));
    expect(await screen.findByText(/服务和工具权限已复制到 OpenCode/)).toBeTruthy();
  });

  it("shows a name conflict without switching providers", async () => {
    copy.mockResolvedValue({ status: "exists" });
    renderManager();
    await screen.findByRole("heading", { name: "local-tools" });
    fireEvent.click(screen.getByRole("button", { name: "复制到 OpenCode" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "目标配置已有同名 MCP 服务“local-tools”，未覆盖。");
    expect((screen.getByRole("tab", { name: "Codex" }) as HTMLButtonElement).getAttribute("aria-selected")).toBe("true");
  });

  it("enables the local session status MCP and shows its manual configuration", async () => {
    renderManager();
    const panel = await screen.findByRole("region", { name: "本机会话 MCP" });
    fireEvent.click(screen.getByRole("button", { name: "启用服务" }));
    await waitFor(() => expect(window.sessionStatusMcpApi.setEnabled).toHaveBeenCalledWith(true));
    expect(await screen.findByText("http://127.0.0.1:43124/mcp")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看令牌" }));
    expect(await screen.findByText("secret")).toBeTruthy();
    fireEvent.click(panel.querySelector("summary") as HTMLElement);
    expect(screen.getByText(/bearer_token_env_var/)).toBeTruthy();
  });
});
