import { describe, expect, it } from "vitest";
import { applyTerminalModifiers, getPairingNonce, getWebSocketUrl, parseServerMessage } from "./protocol";

describe("mobile remote protocol helpers", () => {
  it("uses ws for the selected LAN origin", () => {
    expect(getWebSocketUrl({ protocol: "http:", host: "pannel-handle-pc.local:43123" } as Location))
      .toBe("ws://pannel-handle-pc.local:43123/api/v1/ws");
  });

  it("accepts only bounded URL-safe pairing nonces", () => {
    expect(getPairingNonce("#pair=abcdefghijklmnopqrstuvwx")).toBe("abcdefghijklmnopqrstuvwx");
    expect(getPairingNonce("#pair=bad token")).toBeNull();
  });

  it("encodes Ctrl and Alt terminal input", () => {
    expect(applyTerminalModifiers("c", true, false)).toBe("\x03");
    expect(applyTerminalModifiers("x", false, true)).toBe("\x1bx");
  });

  it("rejects incompatible server messages", () => {
    expect(() => parseServerMessage('{"v":2,"type":"ready"}')).toThrow("协议版本");
  });
});
