// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexWindowsSandboxDialog } from "./CodexWindowsSandboxDialog";
import type { CodexWindowsSandboxSetup } from "../../vite-env";
const idle: CodexWindowsSandboxSetup = { available: true, mode: "elevated", status: "idle", error: null };
afterEach(cleanup);
describe("Windows sandbox dialog", () => {
  it("defaults to elevated and submits the selected mode", async () => {
    const setupWindowsSandbox = vi.fn().mockResolvedValue({});
    Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: { setupWindowsSandbox } });
    render(<CodexWindowsSandboxDialog sessionId="run-1" setup={idle} disabled={false} onClose={vi.fn()} />);
    expect((screen.getByLabelText("管理员模式") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("非管理员模式"));
    fireEvent.click(screen.getByRole("button", { name: "开始初始化" }));
    await waitFor(() => expect(setupWindowsSandbox).toHaveBeenCalledWith("run-1", "unelevated"));
  });
  it("keeps running state when reopened, allows closing and displays completion", () => {
    const onClose = vi.fn();
    const { rerender } = render(<CodexWindowsSandboxDialog sessionId="run-1" setup={{ ...idle, status: "running" }} disabled={false} onClose={onClose} />);
    expect((screen.getByRole("button", { name: "正在初始化…" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledOnce();
    rerender(<CodexWindowsSandboxDialog sessionId="run-1" setup={{ ...idle, status: "succeeded" }} disabled={false} onClose={onClose} />);
    expect(screen.getByRole("status").textContent).toContain("初始化成功");
  });
  it("shows failure and supports retry while blocking busy sessions", async () => {
    const setupWindowsSandbox = vi.fn().mockRejectedValue(new Error("请求失败"));
    Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: { setupWindowsSandbox } });
    const { rerender } = render(<CodexWindowsSandboxDialog sessionId="run-1" setup={{ ...idle, status: "failed", error: "授权失败" }} disabled={false} onClose={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toBe("授权失败");
    fireEvent.click(screen.getByRole("button", { name: "重试初始化" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("请求失败"));
    rerender(<CodexWindowsSandboxDialog sessionId="run-1" setup={idle} disabled={true} onClose={vi.fn()} />);
    expect((screen.getByRole("button", { name: "重试初始化" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
