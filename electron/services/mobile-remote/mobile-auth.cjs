const crypto = require("node:crypto");

const MAX_CONCURRENT_AUTH = 2;
let activePasswordChecks = 0;

function createMobileAuth({ accessStore, now, sendError, sendReady, releaseDeviceSizes, broadcastState, currentState, notifyConnection }) {
  const clients = new Map();
  const failedAttempts = new Map();
  const pendingByIp = new Map();
  const closedSockets = new WeakSet();
  const pendingSockets = new WeakSet();
  let authGeneration = 0;

  function allowAuthAttempt(ip) {
    const attempts = (failedAttempts.get(ip) || []).filter((at) => at >= now() - 60_000);
    failedAttempts.set(ip, attempts);
    return attempts.length + (pendingByIp.get(ip) || 0) < 5;
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

  async function handlePasswordLogin(socket, message) {
    if (socket.readyState !== 1 || closedSockets.has(socket) || socket.authenticated) return;
    if (pendingSockets.has(socket) || activePasswordChecks >= MAX_CONCURRENT_AUTH) {
      sendError(socket, "AUTH_BUSY", "认证正在进行，请稍后再试。");
      return;
    }
    const ip = socket.remoteAddress;
    if (!allowAuthAttempt(ip)) {
      sendError(socket, "AUTH_RATE_LIMIT", "认证尝试过多，请稍后再试。");
      socket.close(1008, "Rate limited");
      return;
    }
    const generation = authGeneration;
    const isValid = () => socket.readyState === 1 && !closedSockets.has(socket)
      && !socket.authenticated && generation === authGeneration;
    pendingSockets.add(socket);
    pendingByIp.set(ip, (pendingByIp.get(ip) || 0) + 1);
    activePasswordChecks += 1;
    try {
      const verified = await accessStore.verifyPassword(message.password);
      if (!isValid()) return;
      if (!verified) {
        failedAttempts.set(ip, [...(failedAttempts.get(ip) || []).filter((at) => at >= now() - 60_000), now()]);
        sendError(socket, "PASSWORD_INVALID", "移动访问密码错误。");
        accessStore.recordAudit("connection.rejected", { remoteAddress: ip, reason: "invalid-password" });
        return;
      }
      authenticateSocket(socket, message.deviceName);
    } catch (error) {
      if (isValid()) sendError(socket, "AUTH_FAILED", "认证失败，请稍后再试。");
    } finally {
      pendingSockets.delete(socket);
      const remaining = pendingByIp.get(ip) - 1;
      if (remaining) pendingByIp.set(ip, remaining);
      else pendingByIp.delete(ip);
      activePasswordChecks -= 1;
    }
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
    authGeneration += 1;
    for (const client of [...clients.values()]) disconnectClient(client.id, reason);
  }

  function handleSocketClosed(socket) {
    closedSockets.add(socket);
    const client = [...clients.values()].find((item) => item.socket === socket);
    if (client) releaseClient(client, socket.mobileCloseReason || "socket-closed");
  }

  return { getClients: () => [...clients.values()], handlePasswordLogin,
    disconnectClient, disconnectAll, handleSocketClosed };
}

module.exports = { createMobileAuth };
