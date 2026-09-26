import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { getMobileHostname, isPrivateIpv4, launchMobileTemplate, listPrivateInterfaces, sanitizeHostLabel } from "./mobile-remote-service.cjs";
import sessionValues from "./mobile-session-values.cjs";

const { toRuntimeSession, toSavedTemplates } = sessionValues;

describe("mobile session mode values", () => {
  it("uses the actual runtime mode for running sessions and the saved preference for templates", () => {
    expect(toRuntimeSession({ id: "run", title: "Codex", type: "windows", agentProvider: "codex", runtimeMode: "app-server" }))
      .toMatchObject({ runtimeMode: "app-server", agentProvider: "codex" });
    const templates = toSavedTemplates({ getLibrary: () => [
      { id: "graph", title: "Graph", type: "wsl", agentProvider: "opencode", graphicalSessionEnabled: true },
      { id: "terminal", title: "Terminal", type: "ssh", agentProvider: "codebuddy", graphicalSessionEnabled: false }
    ] }, { listSessions: () => [] });
    expect(templates.map(value => value.runtimeMode)).toEqual(["app-server", "terminal"]);
  });
});

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

  it("marks successful mobile template launches for usage tracking", async () => {
    const launcher = {
      launchSession: vi.fn(() => Promise.resolve({ id: "run-1" }))
    };
    const template = { id: "template-1" };

    await expect(launchMobileTemplate(launcher, template, 120, 40)).resolves.toEqual({ id: "run-1" });
    expect(launcher.launchSession).toHaveBeenCalledWith(template, {
      cols: 120,
      rows: 40,
      recordUsage: true
    });
  });
});
