// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexConfigurationView } from "../../vite-env";
import { CodexConfigurationPanel } from "./CodexConfigurationPanel";
afterEach(cleanup);
const view: CodexConfigurationView = {
  cwd: "/project", config: { status: "ready", data: { values: { model: "model" }, layers: [] } },
  requirements: { status: "ready", data: null }, profiles: { status: "ready", data: [{ id: "project", allowed: true, reason: null }, { id: "denied", allowed: false, reason: "管理员禁止" }] },
  legacy: [{ id: "readOnly", allowed: true, reason: null }],
  runtime: { mode: "default", executionPermission: "readOnly", permissionProfileId: null }
};
describe("configuration panel shared by desktop and mobile", () => {
  it("shows partial results, disabled profiles and refreshes after selection", async () => {
    const read = vi.fn().mockResolvedValue(view);
    const selectProfile = vi.fn().mockResolvedValue({});
    render(<CodexConfigurationPanel sessionKey="run" locked={false} read={read} selectProfile={selectProfile} selectLegacy={vi.fn()} />);
    await screen.findByText("未配置管理员限制。");
    expect((screen.getByRole("button", { name: "denied" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "project" }));
    await waitFor(() => expect(selectProfile).toHaveBeenCalledWith("project"));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status").textContent).toContain("已应用");
  });
  it("keeps configuration visible while blocking selection during active work", async () => {
    render(<CodexConfigurationPanel sessionKey="run" locked read={async () => ({ ...view, requirements: { status: "error", data: null, error: "无法读取管理员限制。" } })} selectProfile={vi.fn()} selectLegacy={vi.fn()} />);
    await screen.findByText("无法读取管理员限制。");
    expect((screen.getByRole("button", { name: "project" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "刷新配置" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("discards a previous session result and retries read errors", async () => {
    let release!: (value: CodexConfigurationView) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockRejectedValueOnce(new Error("读取失败")).mockResolvedValue(view);
    const props = { locked: false, read, selectProfile: vi.fn(), selectLegacy: vi.fn() };
    const { rerender } = render(<CodexConfigurationPanel {...props} sessionKey="first" />);
    rerender(<CodexConfigurationPanel {...props} sessionKey="second" />);
    await screen.findByRole("alert");
    release({ ...view, cwd: "/stale" });
    expect(screen.queryByText("工作区：/stale")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "刷新配置" }));
    await screen.findByText("工作区：/project");
  });
});
