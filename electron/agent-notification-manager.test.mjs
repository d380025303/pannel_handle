import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createAgentNotificationManager } = require("./agent-notification-manager.cjs");

function createHarness(overrides = {}) {
  const notifications = [];
  class MockNotification {
    static isSupported = vi.fn(() => true);

    constructor(options) {
      this.options = options;
      this.handlers = {};
      this.show = vi.fn();
      this.close = vi.fn(() => this.handlers.close?.());
      notifications.push(this);
    }

    on(eventName, callback) {
      this.handlers[eventName] = callback;
    }

    emit(eventName) {
      this.handlers[eventName]?.();
    }
  }

  const session = { id: "run-1", title: "Main" };
  const windowManager = {
    isMainWindowFocused: vi.fn(() => false),
    focusAndSelectSession: vi.fn(),
    focusWindow: vi.fn()
  };
  const terminalManager = {
    getSession: vi.fn((id) => id === session.id ? session : undefined)
  };
  const logger = { error: vi.fn() };
  const manager = createAgentNotificationManager({
    Notification: MockNotification,
    windowManager,
    terminalManager,
    logger,
    ...overrides
  });

  return { manager, notifications, MockNotification, windowManager, terminalManager, logger };
}

function status(statusName, provider = "claude", extra = {}) {
  return {
    id: "run-1",
    provider,
    status: statusName,
    eventName: "Test",
    timestamp: 1,
    ...extra
  };
}

describe("agent-notification-manager", () => {
  it.each([
    ["waiting_for_permission", "Claude 等待确认"],
    ["completed", "Claude 已完成"],
    ["failed", "Claude 失败"],
    ["ended", "Claude 已结束"]
  ])("notifies for %s", (statusName, title) => {
    const { manager, notifications } = createHarness();

    manager.handleStatus(status(statusName));

    expect(notifications).toHaveLength(1);
    expect(notifications[0].options).toEqual({
      title,
      body: "会话：Main"
    });
    expect(notifications[0].show).toHaveBeenCalledOnce();
  });

  it("includes provider and permission tool in notification text", () => {
    const { manager, notifications } = createHarness();

    manager.handleStatus(status("waiting_for_permission", "codex", { toolName: "shell_command" }));

    expect(notifications[0].options).toEqual({
      title: "Codex 等待确认",
      body: "会话：Main，工具：shell_command"
    });
  });

  it("does not notify for other statuses or while the window is focused", () => {
    const { manager, notifications, windowManager } = createHarness();

    manager.handleStatus(status("running"));
    windowManager.isMainWindowFocused.mockReturnValue(true);
    manager.handleStatus(status("completed"));

    expect(notifications).toHaveLength(0);
  });

  it("does not notify when system notifications are unavailable", () => {
    const { manager, notifications, MockNotification } = createHarness();
    MockNotification.isSupported.mockReturnValue(false);

    manager.handleStatus(status("completed"));

    expect(notifications).toHaveLength(0);
  });

  it("deduplicates repeated statuses and allows a later transition back", () => {
    const { manager, notifications } = createHarness();

    manager.handleStatus(status("completed"));
    manager.handleStatus(status("completed"));
    manager.handleStatus(status("running"));
    manager.handleStatus(status("completed"));

    expect(notifications).toHaveLength(2);
    expect(notifications[0].close).toHaveBeenCalledOnce();
  });

  it("focuses and selects an existing session when clicked", () => {
    const { manager, notifications, windowManager } = createHarness();
    manager.handleStatus(status("failed"));

    notifications[0].emit("click");

    expect(windowManager.focusAndSelectSession).toHaveBeenCalledWith("run-1");
    expect(windowManager.focusWindow).not.toHaveBeenCalled();
  });

  it("only focuses the window when the session was closed before click", () => {
    const { manager, notifications, windowManager, terminalManager } = createHarness();
    manager.handleStatus(status("ended"));
    terminalManager.getSession.mockReturnValue(undefined);

    notifications[0].emit("click");

    expect(windowManager.focusWindow).toHaveBeenCalledOnce();
    expect(windowManager.focusAndSelectSession).not.toHaveBeenCalled();
  });

  it("keeps an existing notification clickable after clearing a closed session", () => {
    const { manager, notifications, windowManager, terminalManager } = createHarness();
    manager.handleStatus(status("ended"));
    manager.clearSession("run-1");
    terminalManager.getSession.mockReturnValue(undefined);

    expect(notifications[0].close).not.toHaveBeenCalled();
    notifications[0].emit("click");
    expect(windowManager.focusWindow).toHaveBeenCalledOnce();
  });

  it("logs notification errors without throwing", () => {
    class FailingNotification {
      static isSupported() {
        return true;
      }

      constructor() {
        throw new Error("notification failed");
      }
    }
    const { manager, logger } = createHarness({ Notification: FailingNotification });

    expect(() => manager.handleStatus(status("failed"))).not.toThrow();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
