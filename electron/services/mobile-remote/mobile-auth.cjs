const crypto = require("node:crypto");

function createMobileAuth({ accessStore, now, sendError, sendReady, releaseDeviceSizes, broadcastState, currentState, notifyConnection }) {
  const clients = new Map();
  const failedAttempts = new Map();

  function allowAuthAttempt(ip) {
    const attempts = (failedAttempts.get(ip) || []).filter((at) => at >= now() - 60_000);
    failedAttempts.set(ip, attempts);
    return attempts.length < 5;
  }

  function releaseClient(client, reason) {
    if (clients.get(client.id) !== client) return;
    clients.delete(client.id);
    client.socket.authenticated = false;
    releaseDeviceSizes(client.id);
    accessStore.recordAudit("connection.disconnected", { deviceId: client.id, deviceName: client.name, reason });
    broadcastState();
  }

  function authenticateSocket(socket, name) {
    const client = {
      id: crypto.randomUUID(),
      name: String(name || "Android Chrome").trim().slice(0, 80) || "Android Chrome",
      remoteAddress: socket.remoteAddress,
      socket
    };
    clients.set(client.id, client);
    socket.mobileDevice = { id: client.id, name: client.name };
    socket.authenticated = true;
    accessStore.recordAudit("connection.accepted", { deviceId: client.id, deviceName: client.name, remoteAddress: client.remoteAddress });
    notifyConnection(socket.mobileDevice);
    sendReady(socket);
    broadcastState();
    return client;
  }

  function handlePasswordLogin(socket, message) {
    if (!allowAuthAttempt(socket.remoteAddress)) {
      sendError(socket, "AUTH_RATE_LIMIT", "认证尝试过多，请稍后再试。");
      socket.close(1008, "Rate limited");
      return;
    }
    if (!accessStore.verifyPassword(message.password)) {
      const ip = socket.remoteAddress;
      failedAttempts.set(ip, [...(failedAttempts.get(ip) || []).filter((at) => at >= now() - 60_000), now()]);
      sendError(socket, "PASSWORD_INVALID", "移动访问密码错误。");
      accessStore.recordAudit("connection.rejected", { remoteAddress: ip, reason: "invalid-password" });
      return;
    }
    authenticateSocket(socket, message.deviceName);
  }

  function disconnectClient(id, reason = "desktop-disconnect") {
    const client = clients.get(id);
    if (client) {
      const code = reason === "password-changed" ? "PASSWORD_CHANGED"
        : reason === "service-stopped" ? "SERVICE_STOPPED" : "CONNECTION_CLOSED";
      const message = reason === "password-changed" ? "移动访问密码已修改，请重新输入。"
        : reason === "service-stopped" ? "电脑端移动服务已停止，正在等待恢复…"
          : "电脑端已断开此连接，请重新输入密码。";
      sendError(client.socket, code, message);
      releaseClient(client, reason);
      client.socket.close(1008, reason);
    }
    return currentState();
  }

  function disconnectAll(reason) {
    for (const client of [...clients.values()]) disconnectClient(client.id, reason);
  }

  function handleSocketClosed(socket) {
    const client = [...clients.values()].find((item) => item.socket === socket);
    if (client) releaseClient(client, socket.mobileCloseReason || "socket-closed");
  }

  return { getClients: () => [...clients.values()], handlePasswordLogin,
    disconnectClient, disconnectAll, handleSocketClosed };
}

module.exports = { createMobileAuth };
