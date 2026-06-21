const NOTIFY_STATUSES = new Set([
  "waiting_for_permission",
  "completed",
  "failed",
  "ended"
]);

const STATUS_LABELS = {
  waiting_for_permission: "等待确认",
  completed: "已完成",
  failed: "失败",
  ended: "已结束"
};

function createAgentNotificationManager({
  Notification,
  windowManager,
  terminalManager,
  logger = console
}) {
  const lastStatusBySessionId = new Map();
  const notificationsBySessionId = new Map();

  function getProviderName(provider) {
    if (provider === "codex") return "Codex";
    if (provider === "opencode") return "OpenCode";
    if (provider === "qoder") return "Qoder";
    return "Claude";
  }

  function buildBody(session, payload) {
    const toolSuffix = payload.status === "waiting_for_permission" && payload.toolName
      ? `，工具：${payload.toolName}`
      : "";
    return `会话：${session.title}${toolSuffix}`;
  }

  function handleStatus(payload) {
    const previousStatus = lastStatusBySessionId.get(payload.id);
    lastStatusBySessionId.set(payload.id, payload.status);

    try {
      if (
        previousStatus === payload.status ||
        !NOTIFY_STATUSES.has(payload.status) ||
        windowManager.isMainWindowFocused() ||
        !Notification.isSupported()
      ) {
        return;
      }

      const session = terminalManager.getSession(payload.id);
      if (!session) {
        return;
      }

      const previousNotification = notificationsBySessionId.get(payload.id);
      if (previousNotification) {
        previousNotification.close();
      }

      const notification = new Notification({
        title: `${getProviderName(payload.provider)} ${STATUS_LABELS[payload.status]}`,
        body: buildBody(session, payload)
      });
      notificationsBySessionId.set(payload.id, notification);

      notification.on("click", () => {
        if (terminalManager.getSession(payload.id)) {
          windowManager.focusAndSelectSession(payload.id);
        } else {
          windowManager.focusWindow();
        }
      });
      notification.on("close", () => {
        if (notificationsBySessionId.get(payload.id) === notification) {
          notificationsBySessionId.delete(payload.id);
        }
      });
      notification.show();
    } catch (err) {
      logger.error("Failed to show agent status notification:", err);
    }
  }

  function clearSession(sessionId) {
    lastStatusBySessionId.delete(sessionId);
  }

  function shutdown() {
    for (const notification of notificationsBySessionId.values()) {
      notification.close();
    }
    notificationsBySessionId.clear();
    lastStatusBySessionId.clear();
  }

  return {
    handleStatus,
    clearSession,
    shutdown
  };
}

module.exports = {
  createAgentNotificationManager
};
