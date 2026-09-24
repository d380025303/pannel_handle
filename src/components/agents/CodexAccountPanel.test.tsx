// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAccountPanel } from "./CodexAccountPanel";
import type { CodexAccountState } from "../../vite-env";

const signedOut: CodexAccountState = { status: "signedOut", requiresOpenaiAuth: true, account: null,
  login: null, rateLimits: null, usage: null, rateLimitsError: null, usageError: null, error: null };
afterEach(cleanup);

describe("Codex account panel", () => {
  it("starts device-code login for a remote session and allows cancellation", async () => {
    const pending: CodexAccountState = { ...signedOut, login: { type: "chatgptDeviceCode", loginId: "login-1",
      url: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" } };
    const startLogin = vi.fn(async () => pending);
    const cancelLogin = vi.fn(async () => signedOut);
    Object.defineProperty(window, "externalLinkApi", { configurable: true, value: { open: vi.fn(async () => undefined) } });
    render(<CodexAccountPanel account={signedOut} preferDeviceCode actions={{
      readAccount: async () => signedOut, startLogin, cancelLogin,
      logout: async () => signedOut, refreshAccountUsage: async () => signedOut
    }} />);
    fireEvent.click(screen.getByRole("button", { name: "未登录" }));
    fireEvent.click(screen.getByRole("button", { name: "使用 ChatGPT 登录" }));
    await waitFor(() => expect(startLogin).toHaveBeenCalledWith("chatgptDeviceCode"));
    expect(await screen.findByText("ABCD-1234")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
    await waitFor(() => expect(cancelLogin).toHaveBeenCalledOnce());
  });

  it("shows account usage and requires a second click to sign out", async () => {
    const loggedIn: CodexAccountState = { ...signedOut, status: "signedIn",
      account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
      rateLimits: { rateLimits: { primary: { usedPercent: 25, resetsAt: 1800000000 } } },
      usage: { summary: { lifetimeTokens: 1200, peakDailyTokens: 300 }, dailyUsageBuckets: [{ startDate: "2026-09-24", tokens: 300 }] } };
    const logout = vi.fn(async () => signedOut);
    render(<CodexAccountPanel account={loggedIn} actions={{ readAccount: async () => loggedIn,
      startLogin: async () => loggedIn, cancelLogin: async () => loggedIn, logout,
      refreshAccountUsage: async () => loggedIn }} />);
    fireEvent.click(screen.getByRole("button", { name: "user@example.com" }));
    expect(screen.getByText(/累计 Token/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "登出" }));
    expect(logout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认登出" }));
    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
  });
});
