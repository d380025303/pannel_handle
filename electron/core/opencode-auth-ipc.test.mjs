import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { registerIpcHandlers } = require("./ipc-handlers.cjs");
const { createGraphicalSessionRouter } = require("../services/codebuddy-acp/session-router.cjs");

it("routes authentication through controlled IPC and ignores terminal messages after session close", () => {
  const handles = new Map(); const events = new Map();
  let session = { agentProvider: "opencode" };
  const terminalManager = { getSession: () => session };
  const openCode = { startAcpLogin: vi.fn(() => ({ generation: 1 })), cancelAcpLogin: vi.fn(), writeAcpLogin: vi.fn(), resizeAcpLogin: vi.fn() };
  const router = createGraphicalSessionRouter({}, {}, terminalManager, openCode);
  registerIpcHandlers({ ipcMain: { handle: (key, value) => handles.set(key, value), on: (key, value) => events.set(key, value) }, terminalManager, codexAppServerSessionService: router });
  expect(handles.get("opencode-auth:start")({}, "one", "login")).toEqual({ generation: 1 });
  expect(openCode.startAcpLogin).toHaveBeenCalledWith("one", "login");
  events.get("opencode-auth:write")({}, "one", 1, "hello");
  events.get("opencode-auth:resize")({}, "one", 1, 80, 20);
  expect(openCode.writeAcpLogin).toHaveBeenCalledWith("one", 1, "hello");
  expect(openCode.resizeAcpLogin).toHaveBeenCalledWith("one", 1, 80, 20);
  session = null;
  events.get("opencode-auth:write")({}, "one", 1, "stale");
  events.get("opencode-auth:resize")({}, "one", 1, 80, 20);
  handles.get("opencode-auth:cancel")({}, "one", 1);
  expect(openCode.writeAcpLogin).toHaveBeenCalledOnce(); expect(openCode.resizeAcpLogin).toHaveBeenCalledOnce();
  expect(openCode.cancelAcpLogin).not.toHaveBeenCalled();
});
