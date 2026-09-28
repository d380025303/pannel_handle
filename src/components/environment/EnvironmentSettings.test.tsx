// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentSettings } from "./EnvironmentSettings";
import { SessionEnvironmentFields } from "./SessionEnvironmentFields";
import type { EnvironmentSelection } from "../../vite-env";
import { useState } from "react";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("environment configuration UI", () => {
  it("creates a group from bulk input and displays saved state", async () => {
    const save = vi.fn(async (input) => [{ ...input, id: "group", references: [] }]);
    window.environmentApi = { list: vi.fn(async () => []), save, delete: vi.fn(), preview: vi.fn() };
    render(<EnvironmentSettings />);
    fireEvent.change(screen.getByLabelText("配置组名称"), { target: { value: "开发代理" } });
    fireEvent.click(screen.getByText("批量粘贴 KEY=VALUE"));
    fireEvent.change(screen.getByLabelText("批量环境变量"), { target: { value: "HTTP_PROXY=http://localhost:7892" } });
    fireEvent.click(screen.getByText("追加到变量表"));
    fireEvent.click(screen.getByText("保存配置组"));
    await screen.findByText("已保存，下次启动会话生效。");
    expect(save).toHaveBeenCalledWith({ id: undefined, name: "开发代理", entries: [{ name: "HTTP_PROXY", value: "http://localhost:7892" }] });
  });
  it("disables deletion of referenced groups and copies them as new drafts", async () => {
    window.environmentApi = { list: vi.fn(async () => [{ id: "dev", name: "开发", entries: [], references: ["终端一"] }]), save: vi.fn(), delete: vi.fn(), preview: vi.fn() };
    render(<EnvironmentSettings />);
    await screen.findByRole("option", { name: "开发" });
    fireEvent.change(screen.getByRole("combobox", { name: "配置组" }), { target: { value: "dev" } });
    expect((screen.getByText("删除配置组") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("终端一")).toBeTruthy();
    fireEvent.click(screen.getByText("复制为新组"));
    expect((screen.getByLabelText("配置组名称") as HTMLInputElement).value).toBe("开发 - 副本");
  });
  it("requires a second click before deleting an unused group", async () => {
    const remove = vi.fn(async () => []);
    window.environmentApi = { list: vi.fn(async () => [{ id: "dev", name: "开发", entries: [], references: [] }]), save: vi.fn(), delete: remove, preview: vi.fn() };
    render(<EnvironmentSettings />);
    await screen.findByRole("option", { name: "开发" });
    fireEvent.change(screen.getByRole("combobox", { name: "配置组" }), { target: { value: "dev" } });
    fireEvent.click(screen.getByText("删除配置组"));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("确认删除"));
    await screen.findByText("配置组已删除。");
    expect(remove).toHaveBeenCalledWith("dev");
  });
  it("previews the selected group and clears the selection explicitly", async () => {
    const preview = vi.fn(async () => [{ name: "FOO", value: "bar", source: "开发" }]);
    window.environmentApi = { list: vi.fn(async () => [{ id: "dev", name: "开发", entries: [], references: [] }]), save: vi.fn(), delete: vi.fn(), preview };
    function Harness() { const [value, setValue] = useState<EnvironmentSelection>({}); return <SessionEnvironmentFields type="windows" value={value} onChange={setValue} />; }
    render(<Harness />);
    await screen.findByRole("option", { name: "开发", hidden: true });
    fireEvent.change(screen.getByLabelText("配置组"), { target: { value: "dev" } });
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ environmentProfileId: "dev" })));
    fireEvent.change(screen.getByLabelText("配置组"), { target: { value: "" } });
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ environmentProfileId: null })));
  });
});
