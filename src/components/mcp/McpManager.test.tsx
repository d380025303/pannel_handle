// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    list.mockImplementation(async ({ provider, scope }) => documentFor(provider, scope));
    reveal.mockResolvedValue({ status: "revealed", value: "top-secret" });
    save.mockImplementation(async ({ draft }) => ({
      status: "saved",
      serverName: draft.name,
      document: { ...documentFor("codex", "user"), version: "v2", servers: [{ ...codexServer, ...draft, id: `user:${draft.name}` }] }
    }));
    remove.mockResolvedValue({ status: "removed", document: { ...documentFor(), version: "v2", servers: [] } });
    Object.defineProperty(window, "mcpApi", { configurable: true, value: { list, reveal, save, remove } });
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

  it("disables project scopes for non-Windows sessions", async () => {
    renderManager({ ...windowsSession, type: "wsl", cwd: "/srv/app" } as TerminalSession);
    await screen.findByRole("heading", { name: "local-tools" });
    expect((screen.getByRole("tab", { name: "项目级" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
