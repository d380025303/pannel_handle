import { describe, expect, it, vi } from "vitest";

const { registerIpcHandlers, updateSessionFromIpc } = await import("./ipc-handlers.cjs");

describe("session IPC handlers", () => {
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
      codexBackend: "codebuddy",
      codexModel: "glm-5.3",
      codexExperimentalAcknowledged
    });

    expect(terminalManager.updateSession).toHaveBeenCalledWith("template-1", expect.objectContaining({
      codexBackend: "codebuddy",
      codexModel: "glm-5.3",
      codexExperimentalAcknowledged
    }));
  });
});
