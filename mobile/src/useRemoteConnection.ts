import { useCallback, useEffect, useRef, useState } from "react";
import { getWebSocketUrl, parseServerMessage, serializeClientMessage } from "./protocol";
import { PROTOCOL_VERSION, type ClientMessage, type ConnectionStatus, type RuntimeSession, type SavedTemplate, type ServerMessage } from "./types";

type TerminalMessage = Extract<ServerMessage,
  { type: "terminal.snapshot" | "terminal.data" | "terminal.exit" | "terminal.size-owner" }>;
type GraphicalMessage = Extract<ServerMessage,
  { type: "graphical.snapshot" | "graphical.history" | "graphical.upload.ready" | "command.ok" | "error" }>;

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
  const [device, setDevice] = useState<{ deviceId: string; deviceName: string } | null>(null);
  const [lastLaunchedId, setLastLaunchedId] = useState<string | null>(null);
  const [commandError, setCommandError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const stoppedRef = useRef(false);
  const retryRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const passwordRef = useRef("");
  const terminalListenersRef = useRef(new Set<(message: TerminalMessage) => void>());
  const graphicalListenersRef = useRef(new Set<(message: GraphicalMessage) => void>());

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
    socket.addEventListener("open", () => {
      if (socketRef.current !== socket) return;
      retryRef.current = 0;
      const deviceName = defaultDeviceName();
      localStorage.setItem("pannel-handle-device-name", deviceName);
      socket.send(serializeClientMessage({ v: PROTOCOL_VERSION, type: "password.login", password: passwordRef.current, deviceName }));
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = parseServerMessage(String(event.data));
        switch (message.type) {
          case "ready":
            setDevice({
              deviceId: message.payload.deviceId,
              deviceName: message.payload.deviceName
            });
            setSessions(message.payload.sessions);
            setTemplates(message.payload.templates);
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
          case "graphical.snapshot":
          case "graphical.history":
          case "graphical.upload.ready":
          case "command.ok":
            graphicalListenersRef.current.forEach((listener) => listener(message));
            break;
          case "error":
            graphicalListenersRef.current.forEach((listener) => listener(message));
            if (["PASSWORD_INVALID", "PASSWORD_CHANGED", "CONNECTION_CLOSED", "AUTH_RATE_LIMIT", "AUTH_REQUIRED", "PROTOCOL_MISMATCH"].includes(message.code)) {
              authenticationFailed = true;
            }
            if (["PASSWORD_INVALID", "PASSWORD_CHANGED", "CONNECTION_CLOSED"].includes(message.code)) {
              passwordRef.current = "";
              setDevice(null);
              setStatus("password-required");
              setStatusMessage(message.message);
              socket.close();
              break;
            }
            if (["AUTH_RATE_LIMIT", "AUTH_REQUIRED", "PROTOCOL_MISMATCH"].includes(message.code)) {
              setStatus("error");
              setStatusMessage(message.message);
            } else if (message.code !== "GRAPHICAL_COMMAND_FAILED") {
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
      if (authenticationFailed) return;
      setStatus("disconnected");
      setStatusMessage("连接已断开，正在重试…");
      const delay = Math.min(8000, 500 * 2 ** retryRef.current++);
      retryTimerRef.current = window.setTimeout(() => connect(), delay);
    });
    socket.addEventListener("error", () => {
      setStatusMessage("无法连接电脑，请确认桌面应用和局域网服务正在运行");
    });
  }, []);

  useEffect(() => {
    stoppedRef.current = false;
    indexedDB.deleteDatabase("pannel-handle-mobile");
    connect();
    const pingTimer = window.setInterval(() => {
      send({ v: PROTOCOL_VERSION, type: "ping", at: Date.now() });
    }, 10_000);
    return () => {
      stoppedRef.current = true;
      window.clearInterval(pingTimer);
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      socketRef.current?.close();
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

  const retry = useCallback(() => {
    socketRef.current?.close();
    connect();
  }, [connect]);

  const login = useCallback((password: string) => {
    socketRef.current?.close();
    passwordRef.current = password;
    connect();
  }, [connect]);

  return {
    status,
    statusMessage,
    sessions,
    templates,
    device,
    lastLaunchedId,
    commandError,
    send,
    retry,
    login,
    onTerminalMessage,
    onGraphicalMessage
  };
}
