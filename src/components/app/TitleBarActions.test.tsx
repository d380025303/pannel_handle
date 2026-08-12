// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TitleBar } from "./TitleBar";

describe("TitleBar session actions", () => {
  afterEach(cleanup);

  it("opens the session library and create dialog from the brand actions", () => {
    const onOpenPicker = vi.fn();
    const onOpenCreate = vi.fn();
    const { container } = render(
      <TitleBar
        activeTitle="PowerShell"
        isMaximized={false}
        mobileAccessState={null}
        onOpenSettings={() => undefined}
        onOpenPicker={onOpenPicker}
        onOpenCreate={onOpenCreate}
      />
    );

    const actionGroup = container.querySelector(".titlebar-actions");
    const libraryButton = screen.getByRole("button", { name: "从库中启动" });
    const createButton = screen.getByRole("button", { name: "新建会话" });

    expect(actionGroup?.contains(libraryButton)).toBe(true);
    expect(actionGroup?.contains(createButton)).toBe(true);
    expect(libraryButton.compareDocumentPosition(createButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(libraryButton);
    fireEvent.click(createButton);

    expect(onOpenPicker).toHaveBeenCalledTimes(1);
    expect(onOpenCreate).toHaveBeenCalledTimes(1);
  });
});
