// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { ProjectTool } from "../../vite-env";
import { ProjectToolsSettings } from "./ProjectToolsSettings";
import { installBrowserPreview } from "../../browser-preview/installBrowserPreview";
const tool: ProjectTool = { name: "list_module_owners", group: "owners", description: "List owners", summary: { "zh-CN": "查询模块负责人", "en-US": "List module owners" }, readOnly: true,
  resultExample: [{ id: "example-owner", version: 1, directories: ["src"] }], inputSchema: { type: "object", properties: {} }, example: {}, conditions: { "zh-CN": "需要临时授权", "en-US": "Requires a temporary grant" }, result: { "zh-CN": "返回最新版本", "en-US": "Returns latest versions" } };
afterEach(cleanup);
function show(locale: "zh-CN" | "en-US" = "zh-CN") { return render(<I18nProvider locale={locale}><ProjectToolsSettings /></I18nProvider>); }
describe("ProjectToolsSettings", () => {
  it("loads the browser preview catalog and searches and opens its examples", async () => {
    installBrowserPreview();
    show();
    await screen.findByRole("button", { name: "详情 list_module_owners" });
    expect(screen.getByRole("button", { name: "详情 get_session_instance_status" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "详情 remote_apply_patch" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "远程文本" } });
    expect(screen.queryByRole("button", { name: "详情 list_module_owners" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "详情 remote_apply_patch" }));
    const dialog = screen.getByRole("dialog", { name: "remote_apply_patch" });
    expect(dialog.textContent).toContain("expectedVersion");
    expect(dialog.textContent).toContain("preview-content-version");
    fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("searches names and summaries, shows details and restores focus", async () => {
    window.projectToolsApi = { list: vi.fn().mockResolvedValue([tool]) };
    show();
    const button = await screen.findByRole("button", { name: "详情 list_module_owners" });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "负责人" } });
    expect(screen.getByRole("button", { name: "详情 list_module_owners" })).toBeTruthy();
    button.focus(); fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: tool.name });
    const close = screen.getByRole("button", { name: "关闭详情" });
    expect(document.activeElement).toBe(close);
    expect(screen.getByText("需要临时授权")).toBeTruthy();
    expect(screen.getByText("返回数据示例")).toBeTruthy();
    expect(dialog.textContent).toContain(JSON.stringify(tool.resultExample, null, 2));
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(dialog.querySelector('[tabindex="0"]'));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
    expect(screen.getByText("没有匹配的工具")).toBeTruthy();
  });
  it("shows result examples in English", async () => {
    window.projectToolsApi = { list: vi.fn().mockResolvedValue([tool]) };
    show("en-US");
    fireEvent.click(await screen.findByRole("button", { name: "Details list_module_owners" }));
    expect(screen.getByText("Example result")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("example-owner");
  });
  it("renders English and surfaces loading failures", async () => {
    window.projectToolsApi = { list: vi.fn().mockRejectedValue(new Error("offline")) };
    show("en-US");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("offline"));
    expect(screen.getByRole("searchbox", { name: "Search tools" })).toBeTruthy();
  });
});
