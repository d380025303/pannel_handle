// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { ClipboardApi, ProjectSearchApi, TerminalApi, TerminalSession, WorkspaceEntrySearchResponse } from "../../vite-env";
import { TerminalComposer } from "./TerminalComposer";

const firstSession: TerminalSession = {
  id: "session-1",
  title: "PowerShell",
  shell: "powershell.exe",
  cwd: "C:\\workspace",
  createdAt: 1,
  type: "windows"
};

const secondSession: TerminalSession = {
  ...firstSession,
  id: "session-2",
  title: "Second"
};

function renderComposer(session: TerminalSession | undefined = firstSession) {
  return render(
    <I18nProvider locale="zh-CN">
      <TerminalComposer session={session} onFocusTerminal={focusTerminal} />
    </I18nProvider>
  );
}

const focusTerminal = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("TerminalComposer", () => {
  const write = vi.fn();
  const scrollIntoView = vi.fn();
  const searchWorkspaceEntries = vi.fn<ProjectSearchApi["searchWorkspaceEntries"]>(async (): Promise<WorkspaceEntrySearchResponse> => ({
    root: firstSession.cwd,
    results: []
  }));
  const pasteImageToSession = vi.fn<ClipboardApi["pasteImageToSession"]>(async () => ({ status: "no_image" }));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView
    });
    window.terminalApi = { write } as unknown as TerminalApi;
    window.projectSearchApi = { searchWorkspaceEntries } as unknown as ProjectSearchApi;
    window.clipboardApi = { pasteImageToSession } as unknown as ClipboardApi;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it("sends with plain Enter and restores focus after clicking send", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "终端输入" }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "review this", selectionStart: 11 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(write).toHaveBeenCalledWith("session-1", "review this");
    expect(textarea.value).toBe("");

    fireEvent.change(textarea, { target: { value: "send by button", selectionStart: 14 } });
    fireEvent.click(screen.getByRole("button", { name: "发送到终端" }));

    expect(write).toHaveBeenCalledWith("session-1", "send by button");
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe("");
  });

  it("hands an initial slash in an Agent session to the native terminal input", () => {
    renderComposer({ ...firstSession, agentProvider: "codex" });
    const textarea = screen.getByRole("textbox", { name: "终端输入" }) as HTMLTextAreaElement;

    const accepted = fireEvent.keyDown(textarea, { key: "/" });

    expect(accepted).toBe(false);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith("session-1", "/");
    expect(focusTerminal).toHaveBeenCalledOnce();
    expect(textarea.value).toBe("");
  });

  it("keeps slash in the composer when native Agent completion does not apply", () => {
    const view = renderComposer();
    const textarea = screen.getByRole("textbox", { name: "终端输入" }) as HTMLTextAreaElement;

    expect(fireEvent.keyDown(textarea, { key: "/" })).toBe(true);

    view.rerender(
      <I18nProvider locale="zh-CN">
        <TerminalComposer
          session={{ ...firstSession, agentProvider: "codex" }}
          onFocusTerminal={focusTerminal}
        />
      </I18nProvider>
    );
    expect(fireEvent.keyDown(textarea, { key: "/", ctrlKey: true })).toBe(true);
    fireEvent.compositionStart(textarea);
    expect(fireEvent.keyDown(textarea, { key: "/", isComposing: true })).toBe(true);
    fireEvent.compositionEnd(textarea);

    fireEvent.change(textarea, { target: { value: "explain ", selectionStart: 8 } });
    expect(fireEvent.keyDown(textarea, { key: "/" })).toBe(true);

    expect(write).not.toHaveBeenCalled();
    expect(focusTerminal).not.toHaveBeenCalled();
  });

  it("keeps Shift+Enter available for multiline input", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "终端输入" }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "first line", selectionStart: 10 } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    fireEvent.change(textarea, { target: { value: "first line\nsecond line", selectionStart: 22 } });

    expect(write).not.toHaveBeenCalled();
    expect(textarea.value).toBe("first line\nsecond line");
  });

  it("does not submit while an IME composition is active", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "终端输入" }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "输入中文", selectionStart: 4 } });
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });

    expect(write).not.toHaveBeenCalled();
    expect(textarea.value).toBe("输入中文");
  });

  it("keeps drafts isolated by session without stealing focus on a switch", () => {
    const view = renderComposer();
    const firstTextarea = screen.getByRole("textbox", { name: "终端输入" }) as HTMLTextAreaElement;
    fireEvent.change(firstTextarea, { target: { value: "first draft", selectionStart: 11 } });

    view.rerender(<I18nProvider locale="zh-CN"><TerminalComposer session={secondSession} onFocusTerminal={focusTerminal} /></I18nProvider>);
    const secondTextarea = screen.getByRole("textbox", { name: "终端输入" }) as HTMLTextAreaElement;
    expect(secondTextarea.value).toBe("");
    expect(document.activeElement).not.toBe(secondTextarea);

    fireEvent.change(secondTextarea, { target: { value: "second draft", selectionStart: 12 } });
    view.rerender(<I18nProvider locale="zh-CN"><TerminalComposer session={firstSession} onFocusTerminal={focusTerminal} /></I18nProvider>);

    expect((screen.getByRole("textbox", { name: "终端输入" }) as HTMLTextAreaElement).value).toBe("first draft");
  });

  it("ignores a stale workspace search response", async () => {
    const firstSearch = deferred<WorkspaceEntrySearchResponse>();
    const secondSearch = deferred<WorkspaceEntrySearchResponse>();
    searchWorkspaceEntries
      .mockImplementationOnce(() => firstSearch.promise)
      .mockImplementationOnce(() => secondSearch.promise);
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "终端输入" });

    fireEvent.change(textarea, { target: { value: "@old", selectionStart: 4 } });
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    fireEvent.change(textarea, { target: { value: "@new", selectionStart: 4 } });
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });

    await act(async () => {
      secondSearch.resolve({
        root: firstSession.cwd,
        results: [{ name: "new.ts", path: "C:\\workspace\\new.ts", relativePath: "new.ts", type: "file" }]
      });
      await secondSearch.promise;
    });
    expect(screen.getAllByText("new.ts")).toHaveLength(2);

    await act(async () => {
      firstSearch.resolve({
        root: firstSession.cwd,
        results: [{ name: "old.ts", path: "C:\\workspace\\old.ts", relativePath: "old.ts", type: "file" }]
      });
      await firstSearch.promise;
    });
    expect(screen.queryByText("old.ts")).toBeNull();
    expect(screen.getAllByText("new.ts")).toHaveLength(2);
  });

  it("selects workspace results with the keyboard and inserts the path", async () => {
    searchWorkspaceEntries.mockResolvedValueOnce({
      root: firstSession.cwd,
      results: [
        { name: "alpha.ts", path: "C:\\workspace\\alpha.ts", relativePath: "alpha.ts", type: "file" },
        { name: "beta.ts", path: "C:\\workspace\\beta.ts", relativePath: "src\\beta.ts", type: "file" }
      ]
    });
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "终端输入" }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "@b", selectionStart: 2 } });
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    await act(async () => { await Promise.resolve(); });
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(scrollIntoView).toHaveBeenCalled();
    expect(textarea.value).toBe("@src\\beta.ts ");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("disables image upload while the clipboard request is pending", async () => {
    const upload = deferred<Awaited<ReturnType<ClipboardApi["pasteImageToSession"]>>>();
    pasteImageToSession.mockImplementationOnce(() => upload.promise);
    renderComposer();
    const uploadButton = screen.getByRole("button", { name: "上传剪贴板图片" }) as HTMLButtonElement;

    fireEvent.click(uploadButton);

    expect(uploadButton.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("正在上传剪贴板图片...");

    await act(async () => {
      upload.resolve({ status: "no_image" });
      await upload.promise;
    });
    expect(uploadButton.disabled).toBe(false);
  });

  it("reports clipboard upload failures", async () => {
    pasteImageToSession.mockRejectedValueOnce(new Error("disk full"));
    renderComposer();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传剪贴板图片" }));
      await Promise.resolve();
    });

    expect(screen.getByRole("alert").textContent).toContain("图片上传失败：disk full");
  });

  it("shows search and clipboard errors independently", async () => {
    searchWorkspaceEntries.mockRejectedValueOnce(new Error("offline"));
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "终端输入" });

    fireEvent.change(textarea, { target: { value: "@file", selectionStart: 5 } });
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("alert").textContent).toContain("搜索失败：offline");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传剪贴板图片" }));
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toContain("剪贴板中没有图片");
  });

  it("inserts a saved clipboard image path and clears the upload status", async () => {
    pasteImageToSession.mockResolvedValueOnce({
      status: "saved",
      path: "C:\\workspace\\.pannel-handle-images\\capture.png",
      size: 1024
    });
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "终端输入" }) as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "上传剪贴板图片" }));
      await Promise.resolve();
    });

    expect(textarea.value).toBe("@.pannel-handle-images\\capture.png ");
    expect(screen.queryByText("正在上传剪贴板图片...")).toBeNull();
    expect(document.activeElement).toBe(textarea);
  });
});
