// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TitleBarActionSettings } from "./TitleBarActionSettings";
import { DEFAULT_TITLE_BAR_ACTION_ORDER } from "../app/titleBarActions";

afterEach(cleanup);

describe("TitleBarActionSettings", () => {
  it("saves visibility and drag order", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<TitleBarActionSettings order={DEFAULT_TITLE_BAR_ACTION_ORDER} hidden={[]}
      screenshotEnabled onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "显示打开终端" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ titleBarHiddenActions: ["terminal"] }));

    const dataTransfer = { effectAllowed: "none", dropEffect: "none", setData: vi.fn() };
    fireEvent.dragStart(screen.getByRole("button", { name: "拖动新建会话调整顺序" }), { dataTransfer });
    const firstRow = container.querySelector(".titlebar-action-row");
    expect(firstRow).not.toBeNull();
    fireEvent.dragOver(firstRow!, { dataTransfer });
    fireEvent.drop(firstRow!, { dataTransfer });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ titleBarActionOrder: ["create", ...DEFAULT_TITLE_BAR_ACTION_ORDER.filter(id => id !== "create")] }));
  });

  it("keeps the error visible when saving fails", async () => {
    render(<TitleBarActionSettings order={DEFAULT_TITLE_BAR_ACTION_ORDER} hidden={[]}
      screenshotEnabled={false} onChange={vi.fn().mockRejectedValue(new Error("disk unavailable"))} />);
    expect(screen.getByText("截图功能已关闭")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "显示打开终端" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("disk unavailable"));
    expect((screen.getByRole("checkbox", { name: "显示打开终端" }) as HTMLInputElement).checked).toBe(true);
  });
});
