// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopMascot } from "./DesktopMascot";

describe("DesktopMascot", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("reflects the current session status without stealing input focus", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const { rerender } = render(<DesktopMascot locale="zh-CN" status="running" sessionTitle="Session A" onAction={vi.fn()} />);
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByRole("button", { name: "和小帕聊聊" }));
    expect(screen.getByText("Session A")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("正在工作");
    rerender(<DesktopMascot locale="zh-CN" status="waiting_for_permission" sessionTitle="Session B" onAction={vi.fn()} />);
    expect(screen.getByText("Session B")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("需要你的回应");
    input.remove();
  });

  it("routes shortcuts only after a click and closes the conversation", () => {
    const onAction = vi.fn();
    render(<DesktopMascot locale="zh-CN" onAction={onAction} />);
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "和小帕聊聊" }));
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(onAction).toHaveBeenCalledWith("skills");
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });

  it("provides local guidance without triggering actions or rendering user HTML", () => {
    const onAction = vi.fn();
    render(<DesktopMascot locale="zh-CN" onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "和小帕聊聊" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "SSH <script>alert(1)</script>" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(screen.getByText(/点击「新建会话」选择 SSH/)).toBeTruthy();
    expect(screen.getByRole("log").querySelector("script")).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
    expect(localStorage.getItem("pannel-handle.desktop-mascot.v1")).not.toContain("script");
  });

  it("persists collapse, animation and keyboard positioning across remounts", () => {
    const props = { locale: "en-US" as const, onAction: vi.fn() };
    const { unmount } = render(<DesktopMascot {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Talk to Panna" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause motion" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Move companion (arrow keys)" }), { key: "ArrowLeft" });
    const saved = JSON.parse(localStorage.getItem("pannel-handle.desktop-mascot.v1")!);
    expect(saved.animated).toBe(false);
    expect(Number.isFinite(saved.x)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Minimize companion" }));
    unmount();
    render(<DesktopMascot {...props} />);
    expect(screen.getByRole("button", { name: "Expand companion" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand companion" }));
    expect(screen.getByRole("button", { name: "Talk to Panna" })).toBeTruthy();
  });

  it("recovers from malformed or out-of-bounds stored preferences", () => {
    localStorage.setItem("pannel-handle.desktop-mascot.v1", JSON.stringify({ x: 1e9, y: -1000 }));
    const { unmount } = render(<DesktopMascot locale="en-US" onAction={vi.fn()} />);
    const companion = screen.getByRole("complementary");
    expect(companion.style.top).toBe("44px");
    expect(parseFloat(companion.style.left)).toBeLessThan(window.innerWidth);
    unmount();
    localStorage.setItem("pannel-handle.desktop-mascot.v1", "invalid JSON");
    render(<DesktopMascot locale="en-US" onAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Talk to Panna" })).toBeTruthy();
  });
});
