import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "./types";

export function parseServerMessage(raw: string): ServerMessage {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("服务端消息不是对象");
  }
  const record = parsed as Record<string, unknown>;
  if (record.v !== PROTOCOL_VERSION || typeof record.type !== "string") {
    throw new Error("服务端协议版本不兼容");
  }
  return parsed as ServerMessage;
}
export function serializeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}
export function getPairingNonce(hash = window.location.hash): string | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const nonce = params.get("pair");
  return nonce && /^[A-Za-z0-9_-]{20,160}$/.test(nonce) ? nonce : null;
}

export function getWebSocketUrl(locationLike: Pick<Location, "protocol" | "host"> = window.location): string {
  const protocol = locationLike.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${locationLike.host}/api/v1/ws`;
}

export function applyTerminalModifiers(data: string, ctrl: boolean, alt: boolean): string {
  let next = data;
  if (ctrl && next.length === 1) {
    const code = next.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) {
      next = String.fromCharCode(code & 31);
    }
  }
  return alt ? `\x1b${next}` : next;
}
