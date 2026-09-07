const crypto = require("node:crypto");
const QRCode = require("qrcode");
const { WebSocket } = require("ws");
const { PAIRING_TTL_MS, MOBILE_GRACE_MS } = require("./mobile-protocol.cjs");
const { createPairingUrls } = require("./mobile-network.cjs");

function createMobileAuth({ accessStore, now, send, sendError, sendReady, releaseDeviceSizes, broadcastState, currentState, confirmPairing, notifyConnection }) {
  let activeClient = null;
  const pairingNonces = new Map();
  const authAttempts = new Map();

  function allowAuthAttempt(ip) {
    const cutoff = now() - 60_000;
    const attempts = (authAttempts.get(ip) || []).filter((at) => at >= cutoff);
    if (attempts.length >= 5) return false;
    attempts.push(now());
    authAttempts.set(ip, attempts);
    return true;
  }

  function releaseActiveClient(reason, immediate = false) {
    if (!activeClient) return;
    const client = activeClient;
    if (client.releaseTimer) clearTimeout(client.releaseTimer);
    const finish = () => {
      if (activeClient !== client) return;
      releaseDeviceSizes(client.device.id);
      accessStore.recordAudit("connection.disconnected", { deviceId: client.device.id, deviceName: client.device.name, reason });
      activeClient = null;
      broadcastState();
    };
    if (immediate) finish();
    else {
      client.graceUntil = now() + MOBILE_GRACE_MS;
      client.releaseTimer = setTimeout(finish, MOBILE_GRACE_MS);
      broadcastState();
    }
  }

  function authenticateSocket(socket, device) {
    if (activeClient && activeClient.device.id !== device.id) {
      sendError(socket, "DEVICE_BUSY", `“${activeClient.device.name}”仍在线，请稍后再试。`);
      accessStore.recordAudit("connection.rejected", { deviceId: device.id, deviceName: device.name, reason: "device-busy" });
      socket.close(1008, "Another mobile device is active");
      return false;
    }
    if (activeClient?.releaseTimer) clearTimeout(activeClient.releaseTimer);
    if (activeClient?.socket && activeClient.socket !== socket) activeClient.socket.close(1000, "同一设备已重新连接");
    const reconnecting = Boolean(activeClient);
    activeClient = activeClient || { device, subscriptions: new Set() };
    activeClient.device = device;
    activeClient.socket = socket;
    activeClient.graceUntil = 0;
    activeClient.releaseTimer = null;
    socket.mobileDevice = device;
    socket.authenticated = true;
    socket.subscriptions = activeClient.subscriptions;
    accessStore.recordAudit("connection.accepted", { deviceId: device.id, deviceName: device.name, reconnecting });
    if (!reconnecting) notifyConnection(device);
    sendReady(socket);
    broadcastState();
    return true;
  }

  async function handlePairRequest(socket, message) {
    const pairing = pairingNonces.get(message.nonce);
    if (!pairing || pairing.used || pairing.expiresAt < now()) {
      sendError(socket, "PAIR_INVALID", "配对二维码已失效，请在电脑端重新生成。");
      return;
    }
    pairing.used = true;
    const deviceName = String(message.deviceName || "Android Chrome").trim().slice(0, 80) || "Android Chrome";
    const verificationCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const requestId = crypto.randomUUID();
    send(socket, { type: "pair.pending", requestId, verificationCode });
    accessStore.recordAudit("pair.requested", { deviceName, remoteAddress: socket.remoteAddress });
    const accepted = await confirmPairing({ deviceName, verificationCode });
    if (!accepted || socket.readyState !== WebSocket.OPEN) {
      if (socket.readyState === WebSocket.OPEN) send(socket, { type: "pair.rejected", reason: "电脑端未允许本次配对。" });
      accessStore.recordAudit("pair.rejected", { deviceName });
      return;
    }
    try {
      const approved = accessStore.addDevice(deviceName);
      send(socket, { type: "pair.approved", deviceId: approved.device.id, deviceName: approved.device.name, token: approved.token });
      authenticateSocket(socket, approved.device);
    } catch (error) {
      sendError(socket, "PAIR_STORAGE_FAILED", error.message || String(error));
    }
  }

  async function createPairing() {
    if (!currentState().running) throw new Error("请先启用移动访问服务。");
    const nonce = crypto.randomBytes(32).toString("base64url");
    const expiresAt = now() + PAIRING_TTL_MS;
    pairingNonces.set(nonce, { expiresAt, used: false });
    const state = currentState();
    const { url, fallbackUrl } = createPairingUrls(state, nonce);
    return { url, fallbackUrl, expiresAt, qrDataUrl: await QRCode.toDataURL(url, { width: 280, margin: 1 }) };
  }

  function revokeDevice(deviceId) {
    const revoked = accessStore.revokeDevice(deviceId);
    if (revoked && activeClient?.device.id === deviceId) {
      sendError(activeClient.socket, "DEVICE_REVOKED", "本设备的信任已被电脑端撤销。");
      activeClient.socket?.close(1008, "Device revoked");
      releaseActiveClient("device-revoked", true);
    }
    broadcastState();
    return currentState();
  }

  function disconnectActiveDevice() {
    if (activeClient?.socket) activeClient.socket.close(1000, "电脑端主动断开");
    releaseActiveClient("desktop-disconnect", true);
    return currentState();
  }
  function handleSocketClosed(socket) {
    if (activeClient?.socket === socket) {
      activeClient.socket = null;
      releaseActiveClient("socket-closed", false);
    }
  }

  function expirePairings() {
    for (const [nonce, pairing] of pairingNonces) {
      if (pairing.expiresAt < now()) pairingNonces.delete(nonce);
    }
  }

  return {
    getActiveClient: () => activeClient,
    allowAuthAttempt, releaseActiveClient, authenticateSocket, handlePairRequest,
    createPairing, revokeDevice, disconnectActiveDevice, handleSocketClosed,
    expirePairings, clearPairings: () => pairingNonces.clear()
  };
}

module.exports = { createMobileAuth };
