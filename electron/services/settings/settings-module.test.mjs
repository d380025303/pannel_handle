import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { SETTINGS_IPC_CHANNELS } = require("./settings-ipc-handlers.cjs");
const { createSettingsModule } = require("./settings-module.cjs");

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(channel => handlers.delete(channel))
  };
}

describe("settings module", () => {
  it("owns provider construction, IPC registration, and idempotent shutdown", () => {
    const ipcMain = createIpcMain();
    const services = [];
    const createRouterService = vi.fn(options => {
      const service = {
        options,
        getConfig: vi.fn(),
        listModels: vi.fn(),
        refreshModels: vi.fn(),
        saveApiKey: vi.fn(),
        clearApiKey: vi.fn(),
        testConnection: vi.fn(),
        verifyModels: vi.fn(),
        setFavorites: vi.fn()
      };
      services.push(service);
      return service;
    });
    const codexModelBridgeModule = {
      getResponsesTransport: vi.fn(backend => `${backend}-transport`),
      getLaunchAdapter: vi.fn(backend => `${backend}-launch`)
    };
    const codeBuddyCodexBridgeService = {
      getConfig: vi.fn(),
      getStatus: vi.fn(),
      listModels: vi.fn(),
      refreshModels: vi.fn(),
      verifyModel: vi.fn(),
      setFavorites: vi.fn(),
      setExperimentalAcknowledged: vi.fn()
    };
    const module = createSettingsModule({
      ipcMain,
      configStore: { getConfig: vi.fn(), updateConfig: vi.fn() },
      dingTalkConfigStore: { getConfig: vi.fn() },
      dingTalkNotificationManager: { updateConfig: vi.fn(), clearCredentials: vi.fn(), testConnection: vi.fn() },
      workBuddyAutoCheckinService: { setEnabled: vi.fn() },
      getMobileRemoteService: vi.fn(),
      openRouterConfigStore: "openrouter-store",
      naraRouterConfigStore: "nararouter-store",
      miniMaxConfigStore: "minimax-store",
      codeBuddyCodexBridgeService,
      codexModelBridgeModule,
      openRouterCatalogFile: "openrouter-catalog.json",
      naraRouterCatalogFile: "nararouter-catalog.json",
      miniMaxCatalogFile: "minimax-catalog.json",
      createRouterService
    });

    expect(createRouterService).toHaveBeenCalledTimes(3);
    expect(createRouterService.mock.calls[0][0]).toEqual({
      store: "openrouter-store",
      catalogFile: "openrouter-catalog.json"
    });
    expect(createRouterService.mock.calls[1][0]).toEqual(expect.objectContaining({
      store: "nararouter-store",
      providerId: "nararouter",
      responsesTransport: "nararouter-transport",
      launchAdapter: "nararouter-launch",
      verificationStrategy: "all"
    }));
    expect(createRouterService.mock.calls[2][0]).toEqual(expect.objectContaining({
      store: "minimax-store",
      providerId: "minimax",
      responsesTransport: "minimax-transport",
      launchAdapter: "minimax-launch",
      transformModels: expect.any(Function)
    }));
    expect(module.openRouterService).toBe(services[0]);
    expect(module.naraRouterService).toBe(services[1]);
    expect(module.miniMaxService).toBe(services[2]);
    expect(ipcMain.handlers.size).toBe(SETTINGS_IPC_CHANNELS.length);

    module.shutdown();
    module.shutdown();
    expect(ipcMain.handlers.size).toBe(0);
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(SETTINGS_IPC_CHANNELS.length);
  });
});
