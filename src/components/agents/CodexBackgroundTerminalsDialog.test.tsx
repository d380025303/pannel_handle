// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexBackgroundTerminalsDialog } from "./CodexBackgroundTerminalsDialog";

const terminal = { itemId: "item-1", processId: "p-1", command: "pnpm dev", cwd: "C:\\project",
  osPid: 42, cpuPercent: 3, rssKb: 2048 };

describe("CodexBackgroundTerminalsDialog", () => {
  afterEach(cleanup);

  it("loads, refreshes, and terminates a listed terminal", async () => {
    const listBackgroundTerminals = vi.fn().mockResolvedValueOnce([terminal]).mockResolvedValueOnce([terminal]).mockResolvedValue([]);
    const terminateBackgroundTerminal = vi.fn().mockResolvedValue({ terminated: true });
    Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: { listBackgroundTerminals, terminateBackgroundTerminal } });
    render(<CodexBackgroundTerminalsDialog sessionId="run-1" onClose={vi.fn()} />);
    expect(await screen.findByText("pnpm dev")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(listBackgroundTerminals).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "终止" }));
    await waitFor(() => expect(terminateBackgroundTerminal).toHaveBeenCalledWith("run-1", "p-1"));
    await waitFor(() => expect(screen.getByText("当前会话没有运行中的后台终端。")).toBeTruthy());
  });

  it("confirms cleaning all terminals and retains the list on failure", async () => {
    const listBackgroundTerminals = vi.fn().mockResolvedValue([terminal]);
    const cleanBackgroundTerminals = vi.fn().mockRejectedValue(new Error("清理失败"));
    Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: { listBackgroundTerminals, cleanBackgroundTerminals } });
    render(<CodexBackgroundTerminalsDialog sessionId="run-1" onClose={vi.fn()} />);
    expect(await screen.findByText("pnpm dev")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全部清理" }));
    expect(cleanBackgroundTerminals).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认全部清理" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("清理失败"));
    expect(screen.getByText("pnpm dev")).toBeTruthy();
  });

  it("shows a list error and allows retry", async () => {
    const listBackgroundTerminals = vi.fn().mockRejectedValueOnce(new Error("读取失败")).mockResolvedValueOnce([terminal]);
    Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: { listBackgroundTerminals } });
    render(<CodexBackgroundTerminalsDialog sessionId="run-1" onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "读取失败");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("pnpm dev")).toBeTruthy();
  });
});
