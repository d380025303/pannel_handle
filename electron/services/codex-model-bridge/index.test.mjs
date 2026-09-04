import { describe, expect, it, vi } from "vitest";
import bridgeModule from "./index.cjs";

const { createCodexModelBridgeModule } = bridgeModule;

function createBridge(overrides = {}) {
  return {
    fetchResponses: vi.fn(),
    getLaunchConfig: vi.fn(async (_session, config) => ({ ...config, registrationId: "launch:test" })),
    bindSession: vi.fn(),
    releaseRegistration: vi.fn(),
    disconnect: vi.fn(),
    shutdown: vi.fn(async () => {}),
    ...overrides
  };
}

describe("Codex model bridge module", () => {
  it("owns provider transports, launch registrations, and lifecycle", async () => {
    const naraRouter = createBridge();
    const miniMax = createBridge();
    const codeBuddy = createBridge({ getLaunchConfig: vi.fn(async () => ({ model: "glm-5.3", registrationId: "launch:codebuddy" })) });
    const responses = [naraRouter, miniMax];
    const module = createCodexModelBridgeModule({
      codeBuddy: { marker: true },
      createResponsesBridge: vi.fn(() => responses.shift()),
      createCodeBuddyBridge: vi.fn(() => codeBuddy)
    });

    const verificationInput = { apiKey: "secret", body: { model: "gpt-test" } };
    module.getResponsesTransport("nararouter")(verificationInput);
    expect(naraRouter.fetchResponses).toHaveBeenCalledWith(verificationInput);

    const launch = await module.getLaunchAdapter("minimax")(
      { type: "windows" },
      { model: "MiniMax-M3" }
    );
    expect(launch.bridgeRegistration).toEqual({ backend: "minimax", id: "launch:test" });
    module.bindSession("session-1", launch.bridgeRegistration);
    module.releaseRegistration(launch.bridgeRegistration);
    expect(miniMax.bindSession).toHaveBeenCalledWith("session-1", "launch:test");
    expect(miniMax.releaseRegistration).toHaveBeenCalledWith("launch:test");

    const codeBuddyLaunch = await module.getCodeBuddyLaunchConfig({ agentProvider: "codex", codexBackend: "codebuddy" });
    expect(codeBuddyLaunch.bridgeRegistration).toEqual({ backend: "codebuddy", id: "launch:codebuddy" });
    expect(module.codeBuddyService).toBe(codeBuddy);

    module.disconnect("session-1");
    expect(naraRouter.disconnect).toHaveBeenCalledWith("session-1");
    expect(miniMax.disconnect).toHaveBeenCalledWith("session-1");
    expect(codeBuddy.disconnect).toHaveBeenCalledWith("session-1");

    await module.shutdown();
    expect(naraRouter.shutdown).toHaveBeenCalledOnce();
    expect(miniMax.shutdown).toHaveBeenCalledOnce();
    expect(codeBuddy.shutdown).toHaveBeenCalledOnce();
  });

  it("rejects bridge-only operations for unknown backends", () => {
    const module = createCodexModelBridgeModule({
      codeBuddy: {},
      createResponsesBridge: vi.fn(() => createBridge()),
      createCodeBuddyBridge: vi.fn(() => createBridge())
    });
    expect(() => module.getLaunchAdapter("openrouter")).toThrow("Unsupported Codex bridge backend: openrouter");
  });
});
