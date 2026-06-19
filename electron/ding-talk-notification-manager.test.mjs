import { createRequire } from "node:module";
import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  validateDingTalkWebhook,
  buildSignedWebhook,
  buildDingTalkMessage,
  createDingTalkNotificationManager
} = require("./ding-talk-notification-manager.cjs");

const webhook = "https://oapi.dingtalk.com/robot/send?access_token=test-token";

function createHarness(overrides = {}) {
  const fetchImpl = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ errcode: 0, errmsg: "ok" })
  }));
  const configStore = {
    getConfig: vi.fn(() => ({ enabled: true, hasWebhook: true, hasSecret: false })),
    getCredentials: vi.fn(() => ({ webhook, secret: "" })),
    updateConfig: vi.fn((input) => ({ enabled: input.enabled ?? true, hasWebhook: true, hasSecret: Boolean(input.secret) })),
    clearCredentials: vi.fn(() => ({ enabled: false, hasWebhook: false, hasSecret: false }))
  };
  const terminalManager = {
    getSession: vi.fn(() => ({ id: "run-1", title: "Main" }))
  };
  const logger = { error: vi.fn() };
  const manager = createDingTalkNotificationManager({
    configStore,
    terminalManager,
    fetchImpl,
    now: () => 1710000000000,
    logger,
    ...overrides
  });
  return { manager, fetchImpl, configStore, terminalManager, logger };
}

function status(statusName, provider = "claude", extra = {}) {
  return {
    id: "run-1",
    provider,
    status: statusName,
    eventName: "Test",
    timestamp: 1710000000000,
    ...extra
  };
}

describe("DingTalk webhook", () => {
  it("accepts only the HTTPS DingTalk custom robot endpoint", () => {
    expect(validateDingTalkWebhook(webhook).hostname).toBe("oapi.dingtalk.com");
    expect(() => validateDingTalkWebhook("http://oapi.dingtalk.com/robot/send?access_token=x")).toThrow();
    expect(() => validateDingTalkWebhook("https://example.com/robot/send?access_token=x")).toThrow();
    expect(() => validateDingTalkWebhook("https://oapi.dingtalk.com/robot/send")).toThrow();
  });

  it("adds the expected timestamp and HMAC-SHA256 signature", () => {
    const timestamp = 1710000000000;
    const secret = "SEC-test";
    const url = new URL(buildSignedWebhook(webhook, secret, timestamp));
    const expected = crypto.createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
    expect(url.searchParams.get("timestamp")).toBe(String(timestamp));
    expect(url.searchParams.get("sign")).toBe(expected);
  });

  it.each([
    ["claude", "Claude"],
    ["codex", "Codex"],
    ["opencode", "OpenCode"],
    ["qoder", "Qoder"]
  ])("builds minimal markdown for %s", (provider, providerName) => {
    const message = buildDingTalkMessage(status("waiting_for_permission", provider, {
      toolName: "shell_command",
      toolInput: { command: "secret" },
      lastAssistantMessage: "private"
    }), { title: "Main", cwd: "C:\\private" });
    expect(message.markdown.title).toContain(`[Pannel Handle] ${providerName} 等待授权`);
    expect(message.markdown.text).toContain("会话：Main");
    expect(message.markdown.text).toContain("工具：shell_command");
    expect(message.markdown.text).not.toContain("secret");
    expect(message.markdown.text).not.toContain("private");
  });
});

describe("ding-talk-notification-manager", () => {
  it.each(["waiting_for_permission", "e_prompt", "failed"])("pushes %s", (statusName) => {
    const { manager, fetchImpl } = createHarness();
    manager.handleStatus(status(statusName));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("ignores non-actionable and repeated statuses, then allows a later transition back", () => {
    const { manager, fetchImpl } = createHarness();
    for (const statusName of ["running", "completed", "ended", "exited"]) {
      manager.handleStatus(status(statusName));
    }
    manager.handleStatus(status("failed"));
    manager.handleStatus(status("failed"));
    manager.handleStatus(status("running"));
    manager.handleStatus(status("failed"));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not push when disabled", () => {
    const { manager, fetchImpl, configStore } = createHarness();
    configStore.getConfig.mockReturnValue({ enabled: false, hasWebhook: true, hasSecret: false });
    manager.handleStatus(status("failed"));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates updates and requires a webhook before enabling", () => {
    const { manager, configStore } = createHarness();
    configStore.getConfig.mockReturnValue({ enabled: false, hasWebhook: false, hasSecret: false });
    expect(() => manager.updateConfig({ enabled: true })).toThrow("请先填写 Webhook");
    expect(() => manager.updateConfig({ webhook: "https://example.com/hook" })).toThrow();
    manager.updateConfig({ enabled: true, webhook });
    expect(configStore.updateConfig).toHaveBeenCalledWith({ enabled: true, webhook });
  });

  it("reports DingTalk business errors from test messages", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errcode: 310000, errmsg: "keywords not in content" })
    }));
    const { manager } = createHarness({ fetchImpl });
    await expect(manager.testConnection()).resolves.toEqual({ ok: false, error: "keywords not in content" });
  });

  it("reports successful test messages", async () => {
    const { manager, fetchImpl } = createHarness();
    await expect(manager.testConnection()).resolves.toEqual({ ok: true });
    const request = fetchImpl.mock.calls[0][1];
    expect(JSON.parse(request.body).markdown.text).toContain("Pannel Handle");
  });

  it("reports non-successful HTTP responses", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({})
    }));
    const { manager } = createHarness({ fetchImpl });
    await expect(manager.testConnection()).resolves.toEqual({
      ok: false,
      error: "钉钉机器人请求失败（HTTP 503）。"
    });
  });

  it("reports network failures from test messages", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const { manager } = createHarness({ fetchImpl });
    await expect(manager.testConnection()).resolves.toEqual({ ok: false, error: "offline" });
  });
});
