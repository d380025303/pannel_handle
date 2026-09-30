import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const { registerIpcHandlers, updateSessionFromIpc } = await import("./ipc-handlers.cjs");
const { createGraphicalSessionRouter } = createRequire(import.meta.url)("../services/codebuddy-acp/session-router.cjs");

describe("session IPC handlers", () => {
  it("forwards Codex account and MCP elicitation IPC through the graphical router", async () => {
    const handlers = new Map();
    const methods = [
      ["codex-app-server:account-read", "readAccount", []],
      ["codex-app-server:account-login", "startLogin", ["chatgptDeviceCode"]],
      ["codex-app-server:account-cancel", "cancelLogin", []],
      ["codex-app-server:account-logout", "logout", []],
      ["codex-app-server:account-usage", "refreshAccountUsage", []],
      ["codex-app-server:mcp-login", "loginMcpServer", ["files"]],
      ["codex-app-server:mcp-reload", "reloadMcpServers", []],
      ["codex-app-server:background-terminals-list", "listBackgroundTerminals", []],
      ["codex-app-server:background-terminal-terminate", "terminateBackgroundTerminal", ["p-1"]],
      ["codex-app-server:background-terminals-clean", "cleanBackgroundTerminals", []],
      ["codex-app-server:resolve-elicitation", "resolveElicitation", [71, "accept", { name: "calendar" }]]
    ];
    const codex = Object.fromEntries(methods.map(([, method]) => [method, vi.fn((...args) => ({ method, args }))]));
    const terminalManager = { getSession: id => ({ agentProvider: id === "codex-1" ? "codex" : "codebuddy" }) };
    const router = createGraphicalSessionRouter(codex, {}, terminalManager);
    registerIpcHandlers({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: vi.fn() },
      terminalManager, codexAppServerSessionService: router });

    for (const [channel, method, args] of methods) {
      expect(await handlers.get(channel)({}, "codex-1", ...args)).toEqual({ method, args: ["codex-1", ...args] });
      expect(codex[method]).toHaveBeenCalledWith("codex-1", ...args);
      expect(() => handlers.get(channel)({}, "buddy-1", ...args)).toThrow("仅 Codex 图形会话支持此操作");
    }
  });

  it("rejects unsupported provider operations before calling a missing service method", () => {
    const handlers = new Map();
    const buddy = { cancelQuestion: vi.fn(() => "cancelled") };
    const openCode = { cancelQuestion: vi.fn(() => "open-cancelled") };
    const terminalManager = { getSession: id => ({ agentProvider: {
      "codex-1": "codex", "buddy-1": "codebuddy", "open-1": "opencode", "unknown-1": "unknown"
    }[id] }) };
    const router = createGraphicalSessionRouter({}, buddy, terminalManager, openCode);
    registerIpcHandlers({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: vi.fn() },
      terminalManager, codexAppServerSessionService: router });

    expect(handlers.get("codex-app-server:cancel-question")({}, "buddy-1", 7)).toBe("cancelled");
    expect(buddy.cancelQuestion).toHaveBeenCalledWith("buddy-1", 7);
    expect(() => handlers.get("codex-app-server:cancel-question")({}, "codex-1", 7)).toThrow("不支持取消提问");
    expect(handlers.get("codex-app-server:cancel-question")({}, "open-1", 7)).toBe("open-cancelled");
    expect(openCode.cancelQuestion).toHaveBeenCalledWith("open-1", 7);
    expect(() => handlers.get("codex-app-server:capabilities")({}, "buddy-1", true)).toThrow("仅 Codex");
    expect(() => handlers.get("codex-app-server:fast-mode")({}, "buddy-1", true)).toThrow("仅 Codex");
    expect(() => handlers.get("codex-app-server:native-mode")({}, "codex-1", "plan")).toThrow("不支持此操作");
    expect(() => handlers.get("codex-app-server:snapshot")({}, "unknown-1")).toThrow("不支持的图形会话 Agent");
  });

  it("reconnects SSH App Server sessions through the App Server service", async () => {
    const handlers = new Map();
    const terminalManager = { getSession: vi.fn(() => ({ id: "ssh-1", type: "ssh", runtimeMode: "app-server" })),
      reconnectSession: vi.fn() };
    const codexAppServerSessionService = { restart: vi.fn(async () => ({ id: "ssh-1" })) };
    registerIpcHandlers({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: vi.fn() },
      terminalManager, codexAppServerSessionService });
    await expect(handlers.get("sessions:reconnect")({}, "ssh-1")).resolves.toEqual({ id: "ssh-1" });
    expect(codexAppServerSessionService.restart).toHaveBeenCalledWith("ssh-1");
    expect(terminalManager.reconnectSession).not.toHaveBeenCalled();
  });
  it.each([true, false])("routes terminal size events with mobile service present = %s", (withMobile) => {
    const listeners = new Map();
    const terminalManager = { resize: vi.fn(), getSession: vi.fn(() => ({ id: "run-1" })) };
    const mobileRemoteService = withMobile ? { resizeFromDesktop: vi.fn(), claimDesktopSize: vi.fn() } : undefined;
    registerIpcHandlers({
      ipcMain: { handle: vi.fn(), on: (channel, listener) => listeners.set(channel, listener) },
      terminalManager,
      mobileRemoteService
    });
    listeners.get("terminal:resize")({}, { id: "run-1", cols: 120, rows: 40 });
    listeners.get("terminal:claim-size")({}, { id: "run-1", cols: 100, rows: 30 });
    if (withMobile) {
      expect(mobileRemoteService.resizeFromDesktop).toHaveBeenCalledWith("run-1", 120, 40);
      expect(mobileRemoteService.claimDesktopSize).toHaveBeenCalledWith("run-1", 100, 30);
      expect(terminalManager.resize).not.toHaveBeenCalled();
    } else {
      expect(terminalManager.resize.mock.calls).toEqual([["run-1", 120, 40], ["run-1", 100, 30]]);
    }
    terminalManager.getSession.mockReturnValue(undefined);
    terminalManager.resize.mockClear();
    mobileRemoteService?.resizeFromDesktop.mockClear();
    mobileRemoteService?.claimDesktopSize.mockClear();
    listeners.get("terminal:resize")({}, { id: "run-1", cols: 120, rows: 40 });
    listeners.get("terminal:claim-size")({}, { id: "run-1", cols: 100, rows: 30 });
    expect(terminalManager.resize).not.toHaveBeenCalled();
    if (withMobile) {
      expect(mobileRemoteService.resizeFromDesktop).not.toHaveBeenCalled();
      expect(mobileRemoteService.claimDesktopSize).not.toHaveBeenCalled();
    }
  });

  it.each([true, null])("forwards the Codex experimental acknowledgement value %s", async (codexExperimentalAcknowledged) => {
    const terminalManager = {
      updateSession: vi.fn(() => [])
    };
    await updateSessionFromIpc(terminalManager, {
      id: "template-1",
      codexBackend: "openrouter",
      codexModel: "vendor/model",
      codexExperimentalAcknowledged
    });

    expect(terminalManager.updateSession).toHaveBeenCalledWith("template-1", expect.objectContaining({
      codexBackend: "openrouter",
      codexModel: "vendor/model",
      codexExperimentalAcknowledged
    }));
  });
});
