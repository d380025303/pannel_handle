// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBuddyMcpApp, CodeBuddyMcpAppContext, mcpAppDocument } from "./CodeBuddyMcpApp";

const bridges = vi.hoisted(() => [] as Array<Record<string, any>>);
vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({
  AppBridge: class {
    constructor() { bridges.push(this); }
    connect = vi.fn(async () => {});
    setHostContext = vi.fn(); sendToolInput = vi.fn(); sendToolResult = vi.fn();
    teardownResource = vi.fn(async () => {}); close = vi.fn(async () => {});
  }, PostMessageTransport: class {}
}));
afterEach(() => { cleanup(); bridges.length = 0; });
function setup() {
  const api = { load: vi.fn(async () => ({ html: "<h1>App</h1>", toolInput: { count: 1 }, toolResult: { content: [] } })),
    prepare: vi.fn(async () => ({ token: "grant", serverName: "test", toolName: "add", arguments: { count: 2 } })),
    resolve: vi.fn(async () => ({ content: [] })), dispose: vi.fn(async () => {}), read: vi.fn() };
  Object.defineProperty(window, "codeBuddyMcpApi", { configurable: true, value: api });
  Object.defineProperty(window, "externalLinkApi", { configurable: true, value: { open: vi.fn() } });
  const fillMessage = vi.fn(async () => {});
  const view = render(<CodeBuddyMcpAppContext.Provider value={{ sessionId: "session", threadId: "thread", enabled: true, fillMessage }}><CodeBuddyMcpApp itemId="item" /></CodeBuddyMcpAppContext.Provider>);
  return { api, fillMessage, view };
}
describe("MCP App host", () => {
  it("injects restrictive CSP before scripts and filters directive injection", () => {
    const html = mcpAppDocument('<script>test()</script><h1>App</h1>', { resourceDomains: ["https://cdn.example", "https://evil.example; connect-src *"] });
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script"));
    expect(html).toContain("https://cdn.example");
    expect(html).not.toContain("evil.example");
    expect(html).toContain("form-action 'none'");
  });
  it("isolates the frame and requires a grant decision before tool dispatch", async () => {
    const { api } = setup();
    await waitFor(() => expect(bridges).toHaveLength(1));
    const iframe = screen.getByTitle("MCP App 沙箱");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    const call = bridges[0].oncalltool({ name: "add", arguments: { count: 2 } });
    await screen.findByRole("dialog", { name: "MCP App 工具授权" });
    expect(api.resolve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("拒绝"));
    await call;
    expect(api.resolve).toHaveBeenCalledWith("session", "grant", false);
  });
  it("fills drafts and rejects unsafe external links", async () => {
    const { fillMessage } = setup();
    await waitFor(() => expect(bridges).toHaveLength(1));
    await bridges[0].onmessage({ content: [{ type: "text", text: "hello" }] });
    expect(fillMessage).toHaveBeenCalledWith("item", [{ type: "text", text: "hello" }]);
    await expect(bridges[0].onopenlink({ url: "javascript:alert(1)" })).rejects.toThrow("HTTP(S)");
    expect(window.externalLinkApi.open).not.toHaveBeenCalled();
  });
  it("invalidates pending authorization and tears down on unmount", async () => {
    const { api, view } = setup();
    await waitFor(() => expect(bridges).toHaveLength(1));
    const call = bridges[0].oncalltool({ name: "add", arguments: {} });
    const rejected = expect(call).rejects.toThrow("失效");
    await screen.findByRole("dialog", { name: "MCP App 工具授权" });
    view.unmount();
    await rejected;
    expect(api.resolve).not.toHaveBeenCalled();
    expect(api.dispose).toHaveBeenCalledWith("session", "thread", "item");
  });
});


it("uses an injected remote API for initial load, revisions and teardown", async () => {
  const { api, view } = setup(); view.unmount(); bridges.length = 0;
  const remote = { ...api, load: vi.fn(async () => ({ html: "<h1>Mobile App</h1>" })), dispose: vi.fn(async () => {}), restart: vi.fn(), runtime: vi.fn(), images: vi.fn() };
  const context = { sessionId: "mobile", threadId: "mobile-thread", enabled: true, fillMessage: vi.fn(), api: remote, openLink: vi.fn(async () => {}) };
  const mobile = render(<CodeBuddyMcpAppContext.Provider value={context}><CodeBuddyMcpApp itemId="remote-item" revision={1} /></CodeBuddyMcpAppContext.Provider>);
  await waitFor(() => expect(remote.load).toHaveBeenCalledWith("mobile", "mobile-thread", "remote-item"));
  const calls = remote.load.mock.calls.length;
  mobile.rerender(<CodeBuddyMcpAppContext.Provider value={context}><CodeBuddyMcpApp itemId="remote-item" revision={2} /></CodeBuddyMcpAppContext.Provider>);
  await waitFor(() => expect(remote.load.mock.calls.length).toBeGreaterThan(calls));
  mobile.unmount(); expect(remote.dispose).toHaveBeenCalledWith("mobile", "mobile-thread", "remote-item");
});
