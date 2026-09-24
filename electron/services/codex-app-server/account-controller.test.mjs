import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createAccountController } = require("./account-controller.cjs");

describe("Codex App Server account controller", () => {
  it("starts an unauthenticated browser login and initializes the caller after its matching completion", async () => {
    let signedIn = false;
    const authenticated = vi.fn();
    const request = vi.fn(async (method) => {
      if (method === "account/read") return signedIn
        ? { requiresOpenaiAuth: true, account: { type: "chatgpt", email: "user@example.com", planType: "plus", token: "secret" } }
        : { requiresOpenaiAuth: true, account: null };
      if (method === "account/login/start") return { type: "chatgpt", loginId: "login-1", authUrl: "https://chatgpt.com/auth" };
      if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 25 } } };
      if (method === "account/usage/read") return { summary: { lifetimeTokens: 100 } };
      return {};
    });
    const controller = createAccountController({ request, changed: vi.fn(), authenticated });
    expect((await controller.refresh()).status).toBe("signedOut");
    expect((await controller.startLogin("chatgpt")).login).toMatchObject({ loginId: "login-1", url: "https://chatgpt.com/auth" });
    expect(request).toHaveBeenCalledWith("account/login/start", { type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "codex" });
    controller.onNotification("account/login/completed", { loginId: "other", success: true });
    expect(authenticated).not.toHaveBeenCalled();
    signedIn = true;
    controller.onNotification("account/login/completed", { loginId: "login-1", success: true });
    await vi.waitFor(() => expect(authenticated).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(controller.snapshot().usage?.summary?.lifetimeTokens).toBe(100));
    expect(controller.snapshot().account).toEqual({ type: "chatgpt", email: "user@example.com", planType: "plus" });
    expect(JSON.stringify(controller.snapshot())).not.toContain("secret");
  });

  it("cancels a device-code login and ignores its late completion", async () => {
    const authenticated = vi.fn();
    const request = vi.fn(async method => method === "account/login/start"
      ? { loginId: "device-1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" }
      : { requiresOpenaiAuth: true, account: null });
    const controller = createAccountController({ request, changed: vi.fn(), authenticated });
    expect((await controller.startLogin("chatgptDeviceCode")).login).toMatchObject({ userCode: "ABCD-1234" });
    await controller.cancelLogin();
    controller.onNotification("account/login/completed", { loginId: "device-1", success: true });
    expect(request).toHaveBeenCalledWith("account/login/cancel", { loginId: "device-1" });
    expect(controller.snapshot().login).toBeNull();
    expect(authenticated).not.toHaveBeenCalled();
  });

  it("keeps rate limits and usage errors separate, and clears them on logout", async () => {
    let signedIn = true;
    const request = vi.fn(async method => {
      if (method === "account/read") return { requiresOpenaiAuth: true,
        account: signedIn ? { type: "chatgpt", email: null, planType: "pro" } : null };
      if (method === "account/rateLimits/read") throw new Error("limits unavailable");
      if (method === "account/usage/read") return { summary: { lifetimeTokens: 3 } };
      if (method === "account/logout") { signedIn = false; return {}; }
      return {};
    });
    const controller = createAccountController({ request, changed: vi.fn() });
    await controller.refresh();
    await controller.refreshUsage();
    expect(controller.snapshot()).toMatchObject({ rateLimitsError: "limits unavailable", usageError: null,
      usage: { summary: { lifetimeTokens: 3 } } });
    signedIn = false;
    controller.onNotification("account/updated", { authMode: null });
    await vi.waitFor(() => expect(controller.snapshot()).toMatchObject({ status: "signedOut", usage: null }));
    signedIn = true;
    await controller.refresh();
    await controller.refreshUsage();
    await controller.logout();
    expect(controller.snapshot()).toMatchObject({ status: "signedOut", usage: null, rateLimits: null });
  });
});
