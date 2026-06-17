import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createQqBotNotificationService } = require("./qq-bot-notification-service.cjs");

function createResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    text: vi.fn(async () => typeof body === "string" ? body : JSON.stringify(body))
  };
}

function createHarness(overrides = {}) {
  let nowValue = 1000;
  const config = {
    enabled: true,
    appId: "app-1",
    clientSecret: "secret-1",
    clientSecretEncrypted: "cipher",
    targetOpenid: "openid-1",
    notifyStatuses: ["waiting_for_permission", "completed", "failed", "ended"],
    queueWhenUnavailable: true,
    ...overrides.config
  };
  const configStore = {
    getQqBotConfig: vi.fn(() => ({ ...config, notifyStatuses: [...config.notifyStatuses] }))
  };
  const terminalManager = {
    getSession: vi.fn((id) => id === "run-1" ? { id, title: "Main" } : undefined)
  };
  const fetchImpl = vi.fn(async (url) => {
    if (String(url).includes("getAppAccessToken")) {
      return createResponse({ access_token: "token-1", expires_in: 7200 });
    }
    if (String(url).endsWith("/gateway")) {
      return createResponse({ url: "wss://gateway.example" });
    }
    return createResponse({});
  });
  const logger = { error: vi.fn() };
  const service = createQqBotNotificationService({
    configStore,
    terminalManager,
    fetchImpl,
    WebSocketImpl: undefined,
    logger,
    now: () => nowValue,
    setTimeoutFn: vi.fn(),
    clearTimeoutFn: vi.fn(),
    ...overrides
  });

  return {
    service,
    config,
    configStore,
    terminalManager,
    fetchImpl,
    logger,
    advance(ms) {
      nowValue += ms;
    }
  };
}

function status(statusName, extra = {}) {
  return {
    id: "run-1",
    provider: "codex",
    status: statusName,
    eventName: "Stop",
    timestamp: 1,
    ...extra
  };
}

describe("qq-bot-notification-service", () => {
  it("caches access tokens while sending multiple messages", async () => {
    const { service, fetchImpl } = createHarness();
    service.handleInboundEvent("C2C_MESSAGE_CREATE", { id: "msg-1", author: { user_openid: "openid-1" } });

    await service.testSend();
    await service.testSend();

    const tokenCalls = fetchImpl.mock.calls.filter(([url]) => String(url).includes("getAppAccessToken"));
    const messageCalls = fetchImpl.mock.calls.filter(([url]) => String(url).includes("/v2/users/openid-1/messages"));
    expect(tokenCalls).toHaveLength(1);
    expect(messageCalls).toHaveLength(2);
  });

  it("deduplicates repeated hook statuses", async () => {
    const { service, fetchImpl } = createHarness();
    service.handleInboundEvent("C2C_MESSAGE_CREATE", { id: "msg-1", author: { user_openid: "openid-1" } });

    await service.handleStatus(status("completed"));
    await service.handleStatus(status("completed"));
    await service.handleStatus(status("running"));
    await service.handleStatus(status("completed"));

    const messageCalls = fetchImpl.mock.calls.filter(([url]) => String(url).includes("/messages"));
    expect(messageCalls).toHaveLength(2);
  });

  it("queues messages until a private chat event opens the reply window", async () => {
    const { service, fetchImpl } = createHarness();

    await service.handleStatus(status("waiting_for_permission", { toolName: "shell_command" }));
    expect(service.getStatus().queuedCount).toBe(1);

    await service.handleInboundEvent("C2C_MESSAGE_CREATE", { id: "msg-1", author: { user_openid: "openid-1" } });

    expect(service.getStatus().queuedCount).toBe(0);
    const messageCalls = fetchImpl.mock.calls.filter(([url]) => String(url).includes("/messages"));
    expect(messageCalls).toHaveLength(1);
    expect(JSON.parse(messageCalls[0][1].body).content).toContain("等待确认");
  });

  it("requeues a status notification when QQ API returns an error", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("getAppAccessToken")) {
        return createResponse({ access_token: "token-1", expires_in: 7200 });
      }
      return createResponse({ message: "rate limited" }, false, 429);
    });
    const { service } = createHarness({ fetchImpl });
    service.handleInboundEvent("C2C_MESSAGE_CREATE", { id: "msg-1", author: { user_openid: "openid-1" } });

    await service.handleStatus(status("failed"));

    expect(service.getStatus()).toEqual(expect.objectContaining({
      queuedCount: 1,
      lastError: "rate limited"
    }));
  });

  it("records inbound events from gateway dispatch packets", () => {
    const { service } = createHarness();

    service.handleGatewayMessage(JSON.stringify({
      op: 0,
      s: 1,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "msg-1",
        author: { user_openid: "openid-1" }
      }
    }));

    expect(service.getStatus()).toEqual(expect.objectContaining({
      targetOpenid: "openid-1",
      lastInboundAt: 1000
    }));
  });

  it("ignores private chat events from other users when a target openid is configured", async () => {
    const { service } = createHarness();

    await service.handleStatus(status("failed"));
    await service.handleInboundEvent("C2C_MESSAGE_CREATE", {
      id: "wrong-msg",
      author: { user_openid: "other-openid" }
    });

    expect(service.getStatus()).toEqual(expect.objectContaining({
      queuedCount: 1,
      lastInboundAt: 0
    }));
  });
});
