import { describe, expect, it } from "vitest";
import { createPairingUrls, getMobileHostname, isPrivateIpv4, listPrivateInterfaces, sanitizeHostLabel } from "./mobile-remote-service.cjs";

describe("mobile remote network helpers", () => {
  it("only accepts RFC1918 IPv4 addresses", () => {
    expect(isPrivateIpv4("192.168.1.9")).toBe(true);
    expect(isPrivateIpv4("172.31.4.2")).toBe(true);
    expect(isPrivateIpv4("10.0.0.4")).toBe(true);
    expect(isPrivateIpv4("127.0.0.1")).toBe(false);
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
  });

  it("lists one usable address for each private adapter", () => {
    expect(listPrivateInterfaces({
      "Wi-Fi": [{ family: "IPv4", internal: false, address: "192.168.1.4" }],
      VPN: [{ family: "IPv4", internal: false, address: "100.64.0.2" }],
      Loopback: [{ family: "IPv4", internal: true, address: "127.0.0.1" }]
    })).toEqual([{ name: "Wi-Fi", address: "192.168.1.4" }]);
  });

  it("creates an mDNS-safe host label", () => {
    expect(sanitizeHostLabel("My PC_01")).toBe("my-pc-01");
    expect(getMobileHostname()).toMatch(/^pannel-handle-[a-z0-9-]+\.local$/);
  });

  it("uses the LAN IP address for the primary pairing URL", () => {
    expect(createPairingUrls({
      canonicalUrl: "http://pannel-handle-dx.local:43123",
      fallbackUrl: "http://192.168.3.9:43123"
    }, "pairing-token")).toEqual({
      url: "http://192.168.3.9:43123/#pair=pairing-token",
      fallbackUrl: "http://pannel-handle-dx.local:43123/#pair=pairing-token"
    });
  });
});
