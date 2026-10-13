import { useCallback, useEffect, useRef, useState } from "react";
import { createRemoteSocket, isPreviewTransport, type RemoteSocket } from "./remoteSocket";
import { getWebSocketUrl, parseServerMessage, serializeClientMessage } from "./protocol";
import { PROTOCOL_VERSION, type ClientMessage, type ConnectionStatus, type ServerMessage } from "./types";

const PASSWORD_STORAGE_KEY = "pannel-handle-mobile-password";
const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 45_000;
const AUTH_FAILURE_CODES = ["PASSWORD_INVALID", "PASSWORD_CHANGED", "CONNECTION_CLOSED", "AUTH_RATE_LIMIT", "AUTH_REQUIRED", "PROTOCOL_MISMATCH"];
const PASSWORD_RESET_CODES = ["PASSWORD_INVALID", "PASSWORD_CHANGED", "CONNECTION_CLOSED"];

function readSavedPassword() {
  try { return localStorage.getItem(PASSWORD_STORAGE_KEY) || ""; }
  catch { return ""; }
}

function defaultDeviceName() {
  let saved = "";
  try { saved = localStorage.getItem("pannel-handle-device-name") || ""; }
  catch { /* Browser storage may be disabled. */ }
  if (saved) return saved;
  const android = navigator.userAgent.match(/Android\s+([\d.]+)/i)?.[1];
  return android ? `Android ${android}` : "Android Chrome";
}

export function useRemoteTransport(onMessage: (message: ServerMessage) => void) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [statusMessage, setStatusMessage] = useState("正在连接电脑…");
  const [device, setDevice] = useState<{ deviceId: string; deviceName: string } | null>(null);
  const [storageWarning, setStorageWarning] = useState("");
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const socketRef = useRef<RemoteSocket | null>(null);
  const lastPongAtRef = useRef(0);
  const authenticatedRef = useRef(false);
  const stoppedRef = useRef(false);
  const retryRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const passwordRef = useRef(readSavedPassword());

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(serializeClientMessage(message));
    return true;
  }, []);

  const connect = useCallback(() => {
    if (stoppedRef.current) return;
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    const previous = socketRef.current;
    socketRef.current = null;
    authenticatedRef.current = false;
    previous?.close();
    setStatus("connecting");
    setStatusMessage("正在连接电脑…");
    if (!passwordRef.current && !isPreviewTransport()) {
      setStatus("password-required");
      setStatusMessage("请输入电脑端设置的移动访问密码");
      return;
    }

    const socket = createRemoteSocket(getWebSocketUrl());
    socketRef.current = socket;
    let authenticationFailed = false;
    const openingTimer = window.setTimeout(() => {
      if (socketRef.current === socket && !authenticatedRef.current) socket.close();
    }, 15_000);
    socket.addEventListener("open", () => {
      if (socketRef.current !== socket) return;
      const deviceName = defaultDeviceName();
      try { localStorage.setItem("pannel-handle-device-name", deviceName); }
      catch { /* Device name is optional. */ }
      socket.send(serializeClientMessage({ v: PROTOCOL_VERSION, type: "password.login", password: passwordRef.current, deviceName }));
    });
    socket.addEventListener("message", event => {
      if (socketRef.current !== socket) return;
      try {
        const message = parseServerMessage(String(event.data));
        if (message.type === "ready") {
          window.clearTimeout(openingTimer);
          authenticatedRef.current = true;
          lastPongAtRef.current = Date.now();
          retryRef.current = 0;
          try { if (!isPreviewTransport()) localStorage.setItem(PASSWORD_STORAGE_KEY, passwordRef.current); setStorageWarning(""); }
          catch { setStorageWarning("浏览器无法保存密码，刷新后需要重新输入。"); }
          setDevice({ deviceId: message.payload.deviceId, deviceName: message.payload.deviceName });
          setStatus("connected");
          setStatusMessage("已连接");
          setConnectionEpoch(current => current + 1);
        }
        onMessage(message);
        if (message.type === "pong") lastPongAtRef.current = Date.now();
        if (message.type !== "error") return;
        if (AUTH_FAILURE_CODES.includes(message.code)) authenticationFailed = true;
        if (PASSWORD_RESET_CODES.includes(message.code)) {
          passwordRef.current = "";
          try { localStorage.removeItem(PASSWORD_STORAGE_KEY); setStorageWarning(""); }
          catch { setStorageWarning("浏览器无法清除已保存的密码，请清除本站点数据。"); }
          setDevice(null);
          setStatus("password-required");
          setStatusMessage(message.message);
          socket.close();
        } else if (message.code === "SERVICE_STOPPED") {
          setStatus("disconnected");
          setStatusMessage(message.message);
        } else if (["AUTH_RATE_LIMIT", "AUTH_REQUIRED", "PROTOCOL_MISMATCH"].includes(message.code)) {
          setStatus("error");
          setStatusMessage(message.message);
        }
      } catch (error) {
        setStatus("error");
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    });
    socket.addEventListener("close", () => {
      window.clearTimeout(openingTimer);
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      authenticatedRef.current = false;
      if (stoppedRef.current || authenticationFailed) return;
      setStatus("disconnected");
      setStatusMessage("连接已断开，正在重试…");
      const delay = Math.min(8000, 500 * 2 ** retryRef.current++);
      retryTimerRef.current = window.setTimeout(() => connect(), delay);
    });
    socket.addEventListener("error", () => {
      if (socketRef.current !== socket) return;
      setStatusMessage("无法连接电脑，请确认桌面应用和局域网服务正在运行");
    });
  }, [onMessage]);

  useEffect(() => {
    stoppedRef.current = false;
    if (!isPreviewTransport()) indexedDB.deleteDatabase("pannel-handle-mobile");
    connect();
    let wasHidden = document.hidden;
    const checkConnection = () => {
      const socket = socketRef.current;
      if (document.hidden) { wasHidden = true; return; }
      if (!socket || socket.readyState !== WebSocket.OPEN || !authenticatedRef.current) return;
      if (wasHidden) { lastPongAtRef.current = Date.now(); wasHidden = false; }
      if (Date.now() - lastPongAtRef.current >= PONG_TIMEOUT_MS) { connect(); return; }
      send({ v: PROTOCOL_VERSION, type: "ping", at: Date.now() });
    };
    const pingTimer = window.setInterval(checkConnection, PING_INTERVAL_MS);
    const onResume = () => { if (!document.hidden) checkConnection(); };
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("pageshow", onResume);
    window.addEventListener("online", onResume);
    return () => {
      stoppedRef.current = true;
      window.clearInterval(pingTimer);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("pageshow", onResume);
      window.removeEventListener("online", onResume);
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [connect, send]);

  const retry = useCallback(() => connect(), [connect]);
  const login = useCallback((password: string) => { passwordRef.current = password; connect(); }, [connect]);
  return { status, statusMessage, device, storageWarning, connectionEpoch, send, retry, login };
}
