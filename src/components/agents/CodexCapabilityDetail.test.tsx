// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexCapabilityDetail } from "./CodexCapabilityDetail";

afterEach(cleanup);

it("loads App details and shows tool availability", async () => {
  const readAppDetail = vi.fn().mockResolvedValue({ id: "github", name: "GitHub", description: "Code hosting",
    accessible: true, enabled: true, callable: true, distributionChannel: "directory", installUrl: null,
    pluginDisplayNames: ["GitHub Plugin"], tools: [{ name: "search", title: "Search", description: "Find code",
      enabled: true, disabledReason: null, readOnly: true }] });
  Object.assign(window, { codexAppServerApi: { readAppDetail } });
  render(<CodexCapabilityDetail sessionId="run-1" target={{ kind: "app", id: "github" }} onClose={vi.fn()} />);
  expect(await screen.findByText("Find code · 只读 · 已启用")).toBeTruthy();
  expect(readAppDetail).toHaveBeenCalledWith("run-1", "github");
});

it("loads a remote plugin skill only when selected", async () => {
  const readPluginSkill = vi.fn().mockResolvedValue({ contents: "# Draw instructions" });
  Object.assign(window, { codexAppServerApi: { readPluginDetail: vi.fn().mockResolvedValue({
    name: "design", marketplaceName: "official", description: "Design", version: "1.0", source: { type: "remote" },
    installed: true, enabled: true, shareUrl: null, remotePluginId: "remote-1",
    skills: [{ name: "draw", description: "Draw", enabled: true }], apps: [], mcpServers: []
  }), readPluginSkill } });
  render(<CodexCapabilityDetail sessionId="run-1" target={{ kind: "plugin", name: "design", marketplace: "official" }} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "draw" }));
  expect(await screen.findByText("# Draw instructions")).toBeTruthy();
  expect(readPluginSkill).toHaveBeenCalledWith("run-1", "design", "official", "draw");
});

it("reads a listed MCP resource and reports a failed read in its detail", async () => {
  const readMcpResource = vi.fn().mockRejectedValueOnce(new Error("resource unavailable"))
    .mockResolvedValue({ contents: [{ uri: "file:///a", mimeType: "text/plain", text: "hello", binary: false }] });
  Object.assign(window, { codexAppServerApi: { readMcpResource } });
  render(<CodexCapabilityDetail sessionId="run-1" target={{ kind: "mcp", server: {
    name: "files", status: "connected", authStatus: "supported", toolsError: null, tools: [],
    resources: [{ uri: "file:///a", name: "A", description: "File A", mimeType: "text/plain" }], resourceTemplates: []
  } }} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "A" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "读取失败：resource unavailable");
  fireEvent.click(screen.getByRole("button", { name: "A" }));
  expect(await screen.findByText("hello")).toBeTruthy();
  await waitFor(() => expect(readMcpResource).toHaveBeenCalledTimes(2));
  expect(readMcpResource).toHaveBeenCalledWith("run-1", "files", "file:///a");
});
