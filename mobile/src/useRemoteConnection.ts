import { useCallback, useEffect, useRef, useState } from "react";
import { getWebSocketUrl, parseServerMessage, serializeClientMessage } from "./protocol";
import { PROTOCOL_VERSION, type ClientMessage, type ConnectionStatus, type RuntimeSession, type SavedTemplate, type ServerMessage, type SessionOverview } from "./types";

type TerminalMessage = Extract<ServerMessage,
  { type: "terminal.snapshot" | "terminal.data" | "terminal.exit" | "terminal.size-owner" }>;
type GraphicalMessage = Extract<ServerMessage,
  { type: "graphical.snapshot" | "graphical.usage" | "graphical.history" | "graphical.upload.ready" | "command.ok" | "error" }>;
type FileMessage = Extract<ServerMessage, { type: "files.list.result" | "files.download.ready" | "error" }>;

const PASSWORD_STORAGE_KEY = "pannel-handle-mobile-password";
const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 45_000;

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
export function useRemoteConnection() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [statusMessage, setStatusMessage] = useState("正在连接电脑…");
  const [sessions, setSessions] = useState<RuntimeSession[]>([]);
  const [overviews, setOverviews] = useState<Record<string, SessionOverview>>({});
  const [templates, setTemplates] = useState<SavedTemplate[]>([]);
  const [device, setDevice] = useState<{ deviceId: string; deviceName: string } | null>(null);
  const [lastLaunchedId, setLastLaunchedId] = useState<string | null>(null);
  const [commandError, setCommandError] = useState("");
  const [storageWarning, setStorageWarning] = useState("");
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const lastPongAtRef = useRef(0);
  const authenticatedRef = useRef(false);
  const stoppedRef = useRef(false);
  const retryRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const passwordRef = useRef(readSavedPassword());
  const terminalListenersRef = useRef(new Set<(message: TerminalMessage) => void>());
  const graphicalListenersRef = useRef(new Set<(message: GraphicalMessage) => void>());
  const fileListenersRef = useRef(new Set<(message: FileMessage) => void>());

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
    if (!passwordRef.current) {
      setStatus("password-required");
      setStatusMessage("请输入电脑端设置的移动访问密码");
      return;
    }

    const socket = new WebSocket(getWebSocketUrl());
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
    socket.addEventListener("message", (event) => {
      if (socketRef.current !== socket) return;
      try {
        const message = parseServerMessage(String(event.data));
        switch (message.type) {
          case "ready":
            window.clearTimeout(openingTimer);
            authenticatedRef.current = true;
            lastPongAtRef.current = Date.now();
            retryRef.current = 0;
            try {
              localStorage.setItem(PASSWORD_STORAGE_KEY, passwordRef.current);
              setStorageWarning("");
            } catch {
              setStorageWarning("浏览器无法保存密码，刷新后需要重新输入。");
            }
            setDevice({
              deviceId: message.payload.deviceId,
              deviceName: message.payload.deviceName
            });
            setSessions(message.payload.sessions);
            setOverviews({});
            setTemplates(message.payload.templates);
            setStatus("connected");
            setStatusMessage("已连接");
            setConnectionEpoch(current => current + 1);
            break;
          case "sessions.changed":
            setSessions(message.sessions);
            setOverviews(current => Object.fromEntries(Object.entries(current).filter(([id]) => message.sessions.some(session => session.id === id))));
            break;
          case "session.overview":
            setOverviews(current => ({ ...current, [message.overview.sessionId]: message.overview }));
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
          case "graphical.snapshot":
          case "graphical.usage":
          case "graphical.history":
          case "graphical.upload.ready":
          case "command.ok":
            graphicalListenersRef.current.forEach((listener) => listener(message));
            break;
          case "files.list.result":
          case "files.download.ready":
            fileListenersRef.current.forEach((listener) => listener(message));
            break;
          case "error":
            graphicalListenersRef.current.forEach((listener) => listener(message));
            fileListenersRef.current.forEach((listener) => listener(message));
            if (["PASSWORD_INVALID", "PASSWORD_CHANGED", "CONNECTION_CLOSED", "AUTH_RATE_LIMIT", "AUTH_REQUIRED", "PROTOCOL_MISMATCH"].includes(message.code)) {
              authenticationFailed = true;
            }
            if (["PASSWORD_INVALID", "PASSWORD_CHANGED", "CONNECTION_CLOSED"].includes(message.code)) {
              passwordRef.current = "";
              try { localStorage.removeItem(PASSWORD_STORAGE_KEY); setStorageWarning(""); }
              catch { setStorageWarning("浏览器无法清除已保存的密码，请清除本站点数据。"); }
              setDevice(null);
              setStatus("password-required");
              setStatusMessage(message.message);
              socket.close();
              break;
            }
            if (message.code === "SERVICE_STOPPED") {
              setStatus("disconnected");
              setStatusMessage(message.message);
              break;
            }
            if (["AUTH_RATE_LIMIT", "AUTH_REQUIRED", "PROTOCOL_MISMATCH"].includes(message.code)) {
              setStatus("error");
              setStatusMessage(message.message);
            } else if (message.code !== "GRAPHICAL_COMMAND_FAILED" && message.code !== "FILE_COMMAND_FAILED") {
              setCommandError(message.message);
            }
            break;
          case "pong":
            lastPongAtRef.current = Date.now();
            break;
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
      if (stoppedRef.current) return;
      if (authenticationFailed) return;
      setStatus("disconnected");
      setStatusMessage("连接已断开，正在重试…");
      const delay = Math.min(8000, 500 * 2 ** retryRef.current++);
      retryTimerRef.current = window.setTimeout(() => connect(), delay);
    });
    socket.addEventListener("error", () => {
      if (socketRef.current !== socket) return;
      setStatusMessage("无法连接电脑，请确认桌面应用和局域网服务正在运行");
    });
  }, []);

  useEffect(() => {
    stoppedRef.current = false;
    indexedDB.deleteDatabase("pannel-handle-mobile");
    connect();
    let wasHidden = document.hidden;
    const checkConnection = () => {
      const socket = socketRef.current;
      if (document.hidden) {
        wasHidden = true;
        return;
      }
      if (!socket || socket.readyState !== WebSocket.OPEN || !authenticatedRef.current) return;
      if (wasHidden) {
        lastPongAtRef.current = Date.now();
        wasHidden = false;
      }
      if (Date.now() - lastPongAtRef.current >= PONG_TIMEOUT_MS) {
        connect();
        return;
      }
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

  const onTerminalMessage = useCallback((listener: (message: TerminalMessage) => void) => {
    terminalListenersRef.current.add(listener);
    return () => terminalListenersRef.current.delete(listener);
  }, []);
  const onGraphicalMessage = useCallback((listener: (message: GraphicalMessage) => void) => {
    graphicalListenersRef.current.add(listener);
    return () => graphicalListenersRef.current.delete(listener);
  }, []);

  const onFileMessage = useCallback((listener: (message: FileMessage) => void) => {
    fileListenersRef.current.add(listener);
    return () => fileListenersRef.current.delete(listener);
  }, []);

  const retry = useCallback(() => {
    connect();
  }, [connect]);

  const login = useCallback((password: string) => {
    passwordRef.current = password;
    connect();
  }, [connect]);

  return {
    status,
    statusMessage,
    sessions,
    overviews,
    templates,
    device,
    lastLaunchedId,
    commandError,
    storageWarning,
    connectionEpoch,
    send,
    retry,
    login,
    onTerminalMessage,
    onGraphicalMessage,
    onFileMessage
  };
}
