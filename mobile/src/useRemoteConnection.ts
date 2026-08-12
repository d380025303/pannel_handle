import { useCallback, useEffect, useRef, useState } from "react";
import { clearStoredDevice, loadStoredDevice, saveStoredDevice, type StoredDevice } from "./deviceToken";
import { getPairingNonce, getWebSocketUrl, parseServerMessage, serializeClientMessage } from "./protocol";
import { PROTOCOL_VERSION, type ClientMessage, type ConnectionStatus, type RuntimeSession, type SavedTemplate, type ServerMessage } from "./types";

type TerminalMessage = Extract<ServerMessage,
  { type: "terminal.snapshot" | "terminal.data" | "terminal.exit" | "terminal.size-owner" }>;

function defaultDeviceName() {
  const saved = localStorage.getItem("pannel-handle-device-name");
  if (saved) return saved;
  const android = navigator.userAgent.match(/Android\s+([\d.]+)/i)?.[1];
  return android ? `Android ${android}` : "Android Chrome";
}
export function useRemoteConnection() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [statusMessage, setStatusMessage] = useState("正在连接电脑…");
  const [sessions, setSessions] = useState<RuntimeSession[]>([]);
  const [templates, setTemplates] = useState<SavedTemplate[]>([]);
  const [device, setDevice] = useState<StoredDevice | null>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [lastLaunchedId, setLastLaunchedId] = useState<string | null>(null);
  const [commandError, setCommandError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const stoppedRef = useRef(false);
  const retryRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const connectAttemptRef = useRef(0);
  const terminalListenersRef = useRef(new Set<(message: TerminalMessage) => void>());

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(serializeClientMessage(message));
    return true;
  }, []);

  const connect = useCallback(async () => {
    if (stoppedRef.current) return;
    const attempt = ++connectAttemptRef.current;
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setStatus("connecting");
    setStatusMessage("正在连接电脑…");
    const pairingNonce = getPairingNonce();
    const stored = await loadStoredDevice().catch(() => null);
    if (stoppedRef.current || attempt !== connectAttemptRef.current) return;
    setDevice(stored);
    if (!pairingNonce && !stored) {
      setStatus("pairing");
      setStatusMessage("请在电脑端打开移动访问设置并扫码配对");
      return;
    }

    const socket = new WebSocket(getWebSocketUrl());
    socketRef.current = socket;
    socket.addEventListener("open", () => {
      if (socketRef.current !== socket) return;
      retryRef.current = 0;
      if (pairingNonce) {
        const deviceName = defaultDeviceName();
        localStorage.setItem("pannel-handle-device-name", deviceName);
        socket.send(serializeClientMessage({ v: PROTOCOL_VERSION, type: "pair.request", nonce: pairingNonce, deviceName }));
      } else if (stored) {
        socket.send(serializeClientMessage({ v: PROTOCOL_VERSION, type: "auth", deviceId: stored.deviceId, token: stored.token }));
      }
    });
    socket.addEventListener("message", async (event) => {
      try {
        const message = parseServerMessage(String(event.data));
        switch (message.type) {
          case "pair.pending":
            setVerificationCode(message.verificationCode);
            setStatus("waiting-approval");
            setStatusMessage("请在电脑端确认本设备和校验码");
            break;
          case "pair.approved": {
            const approved = { deviceId: message.deviceId, deviceName: message.deviceName, token: message.token };
            await saveStoredDevice(approved);
            setDevice(approved);
            window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
            setStatusMessage("配对成功，正在进入终端…");
            break;
          }
          case "pair.rejected":
            setStatus("error");
            setStatusMessage(message.reason || "电脑端拒绝了配对");
            break;
          case "ready":
            setDevice((current) => current ?? {
              deviceId: message.payload.deviceId,
              deviceName: message.payload.deviceName,
              token: ""
            });
            setSessions(message.payload.sessions);
            setTemplates(message.payload.templates);
            setVerificationCode("");
            setStatus("connected");
            setStatusMessage("已连接");
            break;
          case "sessions.changed":
            setSessions(message.sessions);
            break;
          case "templates.changed":
            setTemplates(message.templates);
            break;
          case "session.launched":
            setLastLaunchedId(message.sessionId);
            setCommandError("");
            break;
          case "terminal.snapshot":
          case "terminal.data":
          case "terminal.exit":
          case "terminal.size-owner":
            terminalListenersRef.current.forEach((listener) => listener(message));
            break;
          case "error":
            if (message.code === "AUTH_INVALID" || message.code === "DEVICE_REVOKED") {
              await clearStoredDevice();
              setDevice(null);
            }
            if (["AUTH_INVALID", "DEVICE_REVOKED", "AUTH_REQUIRED", "PROTOCOL_MISMATCH", "DEVICE_BUSY"].includes(message.code)) {
              setStatus("error");
              setStatusMessage(message.message);
            } else {
              setCommandError(message.message);
            }
            break;
          case "pong":
            break;
        }
      } catch (error) {
        setStatus("error");
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    });
    socket.addEventListener("close", () => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      if (stoppedRef.current) return;
      setStatus("disconnected");
      setStatusMessage("连接已断开，正在重试…");
      const delay = Math.min(8000, 500 * 2 ** retryRef.current++);
      retryTimerRef.current = window.setTimeout(() => void connect(), delay);
    });
    socket.addEventListener("error", () => {
      setStatusMessage("无法连接电脑，请确认桌面应用和局域网服务正在运行");
    });
  }, [send]);

  useEffect(() => {
    stoppedRef.current = false;
    void connect();
    const pingTimer = window.setInterval(() => {
      send({ v: PROTOCOL_VERSION, type: "ping", at: Date.now() });
    }, 10_000);
    return () => {
      stoppedRef.current = true;
      connectAttemptRef.current += 1;
      window.clearInterval(pingTimer);
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      socketRef.current?.close();
    };
  }, [connect, send]);

  const onTerminalMessage = useCallback((listener: (message: TerminalMessage) => void) => {
    terminalListenersRef.current.add(listener);
    return () => terminalListenersRef.current.delete(listener);
  }, []);

  const retry = useCallback(() => {
    socketRef.current?.close();
    void connect();
  }, [connect]);

  return {
    status,
    statusMessage,
    sessions,
    templates,
    device,
    verificationCode,
    lastLaunchedId,
    commandError,
    send,
    retry,
    onTerminalMessage
  };
}
