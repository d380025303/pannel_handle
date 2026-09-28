import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const preloadPath = fileURLToPath(new URL("./preload.cjs", import.meta.url));

function loadPreload() {
  const exposed = new Map();
  const listeners = new Map();
  const invoke = vi.fn(async (channel) => channel);
  const send = vi.fn();
  const ipcRenderer = {
    invoke,
    send,
    on: vi.fn((channel, listener) => listeners.set(channel, listener)),
    removeListener: vi.fn((channel) => listeners.delete(channel))
  };
  runInNewContext(readFileSync(preloadPath, "utf8"), {
    require: id => {
      if (id !== "electron") throw new Error(`Unexpected module: ${id}`);
      return {
        contextBridge: { exposeInMainWorld: (name, api) => exposed.set(name, api) },
        ipcRenderer,
        webUtils: { getPathForFile: file => file.path }
      };
    }
  });
  return { exposed, listeners, invoke, send, ipcRenderer };
}

describe("preload API wiring", () => {
  it("exposes the APIs needed during application startup", async () => {
    const { exposed, invoke, send, listeners } = loadPreload();
    await exposed.get("launchTemplateApi").list();
    await exposed.get("agentConversationApi").getSnapshot();
    await exposed.get("mobileAccessApi").getState();
    exposed.get("agentConversationApi").setActiveSession("session-1");

    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "launch-templates:list",
      "agent-conversation:get-snapshot",
      "mobile-access:get-state"
    ]);
    expect(send).toHaveBeenCalledWith("agent-conversation:set-active-session", "session-1");

    const onStateChanged = vi.fn();
    const unsubscribe = exposed.get("mobileAccessApi").onStateChanged(onStateChanged);
    listeners.get("mobile-access:state-changed")({}, { running: true });
    expect(onStateChanged).toHaveBeenCalledWith({ running: true });
    unsubscribe();
    expect(listeners.has("mobile-access:state-changed")).toBe(false);
  });
});
