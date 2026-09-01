import { describe, expect, it, vi } from "vitest";

const { updateSessionFromIpc } = await import("./ipc-handlers.cjs");

describe("session IPC handlers", () => {
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
