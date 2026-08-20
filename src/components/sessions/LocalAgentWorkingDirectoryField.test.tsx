// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { LocalAgentWorkingDirectoryField } from "./LocalAgentWorkingDirectoryField";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LocalAgentWorkingDirectoryField", () => {
  it("selects and clears a Windows directory through the controlled picker", async () => {
    const onChange = vi.fn();
    const selectProjectDirectory = vi.fn(async () => ({ canceled: false as const, path: "C:\\work space" }));
    Object.defineProperty(window, "hookConfigApi", {
      configurable: true,
      value: { selectProjectDirectory }
    });

    const { rerender } = render(
      <I18nProvider locale="zh-CN">
        <LocalAgentWorkingDirectoryField value="" onChange={onChange} />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith("C:\\work space"));
    expect(selectProjectDirectory).toHaveBeenCalledWith(undefined);

    rerender(
      <I18nProvider locale="zh-CN">
        <LocalAgentWorkingDirectoryField value="C:\\work space" onChange={onChange} />
      </I18nProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });
});
