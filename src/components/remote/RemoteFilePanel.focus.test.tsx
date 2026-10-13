// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { INPUT_INTERRUPTION_END_EVENT, INPUT_INTERRUPTION_START_EVENT } from "../../hooks/inputRecovery";
import { RemoteFilePanel } from "./RemoteFilePanel";
import type { RemoteFileApi, TerminalSession } from "../../vite-env";

const rootPath = "C:\\workspace";
const filePath = `${rootPath}\\notes.txt`;

describe("RemoteFilePanel file activation", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(Range.prototype, "getClientRects");
  });

  it("checks a dirty file for conflicts only when that file changes", async () => {
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
    let onChanged!: Parameters<RemoteFileApi["onChanged"]>[0];
    const previewFile = vi.fn(async (_sessionId: string, path: string) => ({ kind: "text" as const, path, content: "hello" }));
    const readText = vi.fn(async () => ({ kind: "text" as const, path: filePath, content: "external" }));
    window.remoteFileApi = {
      getHome: vi.fn(async () => rootPath),
      list: vi.fn(async () => [{ name: "notes.txt", path: filePath, type: "file", size: 5, modifiedAt: 1 }]),
      previewFile, readText,
      onDownloadProgress: vi.fn(() => () => undefined), watchDirectories: vi.fn(async () => true),
      unwatchDirectories: vi.fn(async () => true), onWatchError: vi.fn(() => () => undefined),
      onChanged: vi.fn(callback => { onChanged = callback; return () => undefined; })
    } as unknown as RemoteFileApi;
    const session = { id: "session-1", type: "windows", cwd: rootPath } as TerminalSession;
    const previewHost = document.createElement("div");
    document.body.append(previewHost);
    const onPreviewTabsChange = vi.fn();
    const view = render(<RemoteFilePanel session={session} previewHost={previewHost} onPreviewTabsChange={onPreviewTabsChange} />);
    try {
      fireEvent.doubleClick((await screen.findByTitle(filePath)).closest("button")!);
      await waitFor(() => expect(onPreviewTabsChange).toHaveBeenLastCalledWith([expect.objectContaining({ status: "ready" })]));
      view.rerender(<RemoteFilePanel session={session} previewHost={previewHost} activePreviewTabId={`${session.id}:${filePath}`} onPreviewTabsChange={onPreviewTabsChange} />);
      await waitFor(() => expect(previewHost.querySelector(".cm-editor")).not.toBeNull());
      const editor = EditorView.findFromDOM(previewHost.querySelector<HTMLElement>(".cm-editor")!)!;
      act(() => { editor.dispatch({ changes: { from: 0, to: 5, insert: "local" } }); });
      await waitFor(() => expect(onPreviewTabsChange).toHaveBeenLastCalledWith([expect.objectContaining({ dirty: true })]));
      await act(async () => { onChanged({ sessionId: session.id, paths: [rootPath], changedFiles: [`${rootPath}\\unopened.log`] }); });
      expect(readText).not.toHaveBeenCalled();
      expect(previewHost.querySelector(".remote-preview-save-message.conflict")).toBeNull();
      await act(async () => { onChanged({ sessionId: session.id, paths: [rootPath], changedFiles: [filePath] }); });
      expect(readText).toHaveBeenCalledExactlyOnceWith(session.id, filePath);
      expect(previewHost.querySelector(".remote-preview-save-message.conflict")).not.toBeNull();
      expect(previewFile).toHaveBeenCalledTimes(1);
      expect(editor.state.doc.toString()).toBe("local");
    } finally {
      view.unmount();
      previewHost.remove();
    }
  });

  it("selects on click, supports Ctrl and visible Shift ranges, and opens on double click", async () => {
    const paths = ["a.txt", "b.txt", "c.txt"].map((name) => `${rootPath}\\${name}`);
    const folder = `${rootPath}\\folder`;
    const previewFile = vi.fn(async (_sessionId: string, path: string) => ({ kind: "text" as const, path, content: "hello" }));
    const list = vi.fn(async (_sessionId: string, path: string) => path === rootPath
      ? [...paths.map((entry, index) => ({ name: `${String.fromCharCode(97 + index)}.txt`, path: entry, type: "file" as const, size: 1, modifiedAt: 0 })), { name: "folder", path: folder, type: "directory" as const, size: 0, modifiedAt: 0 }]
      : []);
    window.remoteFileApi = {
      getHome: vi.fn(async () => rootPath), list, previewFile,
      onDownloadProgress: vi.fn(() => () => undefined), watchDirectories: vi.fn(async () => true),
      unwatchDirectories: vi.fn(async () => true), onChanged: vi.fn(() => () => undefined), onWatchError: vi.fn(() => () => undefined)
    } as unknown as RemoteFileApi;
    const session = { id: "session-1", type: "windows", name: "Windows" } as unknown as TerminalSession;
    render(<RemoteFilePanel session={session} />);
    const rows = await Promise.all(paths.map(async (path) => (await screen.findByTitle(path)).closest("button")!));
    const folderRow = (await screen.findByTitle(folder)).closest("button")!;
    fireEvent.click(rows[0]);
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
    expect(previewFile).not.toHaveBeenCalled();
    fireEvent.click(rows[2], { ctrlKey: true });
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
    expect(rows[2].getAttribute("aria-selected")).toBe("true");
    fireEvent.click(rows[1], { shiftKey: true });
    expect(rows.map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true", "true"]);
    fireEvent.doubleClick(rows[1]);
    await waitFor(() => expect(previewFile).toHaveBeenCalledWith(session.id, paths[1]));
    fireEvent.click(folderRow);
    expect(list).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(folderRow);
    await waitFor(() => expect(list).toHaveBeenCalledWith(session.id, folder));
  });

  it("keeps a multi-selection on right click and downloads the selected entries together", async () => {
    const paths = ["a.txt", "b.txt", "c.txt"].map((name) => `${rootPath}\\${name}`);
    window.remoteFileApi = {
      getHome: vi.fn(async () => rootPath),
      list: vi.fn(async () => paths.map((path) => ({ name: path.split("\\").at(-1)!, path, type: "file", size: 1, modifiedAt: 0 }))),
      onDownloadProgress: vi.fn(() => () => undefined), watchDirectories: vi.fn(async () => true),
      unwatchDirectories: vi.fn(async () => true), onChanged: vi.fn(() => () => undefined), onWatchError: vi.fn(() => () => undefined)
    } as unknown as RemoteFileApi;
    const chooseDownloadBatch = vi.fn(async () => ({ canceled: false, tasks: [] }));
    window.fileTransferApi = { chooseDownloadBatch } as unknown as Window["fileTransferApi"];
    render(<RemoteFilePanel session={{ id: "session-1", type: "windows", name: "Windows" } as unknown as TerminalSession} />);
    const rows = await Promise.all(paths.map(async (path) => (await screen.findByTitle(path)).closest("button")!));
    fireEvent.click(rows[0]);
    fireEvent.click(rows[1], { ctrlKey: true });
    fireEvent.contextMenu(rows[1]);
    expect(rows.slice(0, 2).map((row) => row.getAttribute("aria-selected"))).toEqual(["true", "true"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "下载" }));
    await waitFor(() => expect(chooseDownloadBatch).toHaveBeenCalledWith("session-1", expect.arrayContaining([
      expect.objectContaining({ path: paths[0] }), expect.objectContaining({ path: paths[1] })
    ])));
    fireEvent.contextMenu(rows[2]);
    expect(rows.map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
  });

  it("opens a requested source file and selects its requested line", async () => {
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
    const previewFile = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
      return { kind: "text" as const, path: filePath, content: "one\ntwo\nthree" };
    });
    window.remoteFileApi = {
      getHome: vi.fn(async () => rootPath),
      list: vi.fn(async () => [{ name: "notes.txt", path: filePath, type: "file", size: 13, modifiedAt: 0 }]),
      previewFile,
      onDownloadProgress: vi.fn(() => () => undefined),
      watchDirectories: vi.fn(async () => true),
      unwatchDirectories: vi.fn(async () => true),
      onChanged: vi.fn(() => () => undefined),
      onWatchError: vi.fn(() => () => undefined)
    } as unknown as RemoteFileApi;
    const session: TerminalSession = { id: "session-1", title: "Windows", shell: "powershell.exe", cwd: rootPath, createdAt: 1, type: "windows" };
    const previewHost = document.createElement("div");
    document.body.append(previewHost);
    const onActivePreviewTabChange = vi.fn();
    const onOpenRequestHandled = vi.fn();
    const onPreviewTabsChange = vi.fn();
    const props = { session, previewHost, onActivePreviewTabChange, onOpenRequestHandled, onPreviewTabsChange };
    const request = { sessionId: session.id, path: filePath, line: 3, requestId: 1 };
    const view = render(<RemoteFilePanel {...props} />);
    await screen.findByTitle(filePath);
    view.rerender(<RemoteFilePanel {...props} openRequest={request} />);
    await waitFor(() => expect(onOpenRequestHandled).toHaveBeenCalledWith(1));
    expect(previewFile).toHaveBeenCalledWith(session.id, filePath);
    expect(onActivePreviewTabChange).toHaveBeenCalledWith(`${session.id}:${filePath}`);
    await waitFor(() => expect(onPreviewTabsChange).toHaveBeenLastCalledWith([expect.objectContaining({ path: filePath, status: "ready" })]));
    view.rerender(<RemoteFilePanel {...props} openRequest={request} activePreviewTabId={`${session.id}:${filePath}`} />);
    await waitFor(() => {
      const host = previewHost.querySelector<HTMLElement>(".cm-editor");
      const editor = host && EditorView.findFromDOM(host);
      expect(editor?.state.selection.main.head).toBe(8);
    });
    previewHost.remove();
  });

  it("reactivates an already selected file without reloading its preview", async () => {
    const previewFile = vi.fn(async (_sessionId: string, path: string) => ({
      kind: "text" as const,
      path,
      content: "hello"
    }));
    window.remoteFileApi = {
      getHome: vi.fn(async () => rootPath),
      list: vi.fn(async () => [{ name: "notes.txt", path: filePath, type: "file", size: 5, modifiedAt: 0 }]),
      previewFile,
      onDownloadProgress: vi.fn(() => () => undefined),
      watchDirectories: vi.fn(async () => true),
      unwatchDirectories: vi.fn(async () => true),
      onChanged: vi.fn(() => () => undefined),
      onWatchError: vi.fn(() => () => undefined)
    } as unknown as RemoteFileApi;
    const session: TerminalSession = {
      id: "session-1",
      title: "Windows",
      shell: "powershell.exe",
      cwd: rootPath,
      createdAt: 1,
      type: "windows"
    };
    const onActivePreviewTabChange = vi.fn();

    render(<RemoteFilePanel session={session} onActivePreviewTabChange={onActivePreviewTabChange} />);

    const notes = await screen.findByTitle(filePath);
    fireEvent.doubleClick(notes.closest("button")!);
    await waitFor(() => expect(previewFile).toHaveBeenCalledTimes(1));
    const openedTabId = onActivePreviewTabChange.mock.calls[0]?.[0];
    expect(openedTabId).toBeTruthy();

    onActivePreviewTabChange.mockClear();
    fireEvent.doubleClick(notes.closest("button")!);

    expect(onActivePreviewTabChange).toHaveBeenCalledWith(openedTabId);
    expect(previewFile).toHaveBeenCalledTimes(1);
  });

  it("scopes preview tabs to the active session and restores them when switching back", async () => {
    const secondRootPath = "C:\\workspace-2";
    const secondFilePath = `${secondRootPath}\\todo.txt`;
    const previewFile = vi.fn(async (_sessionId: string, path: string) => ({
      kind: "text" as const,
      path,
      content: "hello"
    }));
    window.remoteFileApi = {
      getHome: vi.fn(async (sessionId: string) => sessionId === "session-1" ? rootPath : secondRootPath),
      list: vi.fn(async (sessionId: string) => sessionId === "session-1"
        ? [{ name: "notes.txt", path: filePath, type: "file", size: 5, modifiedAt: 0 }]
        : [{ name: "todo.txt", path: secondFilePath, type: "file", size: 5, modifiedAt: 0 }]),
      previewFile,
      onDownloadProgress: vi.fn(() => () => undefined),
      watchDirectories: vi.fn(async () => true),
      unwatchDirectories: vi.fn(async () => true),
      onChanged: vi.fn(() => () => undefined),
      onWatchError: vi.fn(() => () => undefined)
    } as unknown as RemoteFileApi;
    const firstSession: TerminalSession = {
      id: "session-1",
      title: "Windows 1",
      shell: "powershell.exe",
      cwd: rootPath,
      createdAt: 1,
      type: "windows"
    };
    const secondSession: TerminalSession = {
      ...firstSession,
      id: "session-2",
      title: "Windows 2",
      cwd: secondRootPath,
      createdAt: 2
    };
    const onPreviewTabsChange = vi.fn();
    const onActivePreviewTabChange = vi.fn();
    const view = render(
      <RemoteFilePanel
        session={firstSession}
        onPreviewTabsChange={onPreviewTabsChange}
        onActivePreviewTabChange={onActivePreviewTabChange}
      />
    );

    const notes = await screen.findByTitle(filePath);
    fireEvent.doubleClick(notes.closest("button")!);
    await waitFor(() => expect(onPreviewTabsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ sessionId: firstSession.id, fileName: "notes.txt" })
    ]));
    const openedTabId = onActivePreviewTabChange.mock.calls.at(-1)?.[0];

    view.rerender(
      <RemoteFilePanel
        session={secondSession}
        onPreviewTabsChange={onPreviewTabsChange}
        onActivePreviewTabChange={onActivePreviewTabChange}
      />
    );

    await waitFor(() => expect(onPreviewTabsChange).toHaveBeenLastCalledWith([]));
    expect(onActivePreviewTabChange).toHaveBeenCalledWith(null, true);
    fireEvent.doubleClick((await screen.findByTitle(secondFilePath)).closest("button")!);
    await waitFor(() => expect(onPreviewTabsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ sessionId: secondSession.id, fileName: "todo.txt" })
    ]));

    view.rerender(
      <RemoteFilePanel
        session={firstSession}
        onPreviewTabsChange={onPreviewTabsChange}
        onActivePreviewTabChange={onActivePreviewTabChange}
      />
    );

    await waitFor(() => expect(onPreviewTabsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ sessionId: firstSession.id, fileName: "notes.txt" })
    ]));
    expect(onActivePreviewTabChange).toHaveBeenCalledWith(openedTabId, true);
    expect(previewFile).toHaveBeenCalledTimes(2);

    view.rerender(
      <RemoteFilePanel
        session={secondSession}
        onPreviewTabsChange={onPreviewTabsChange}
        onActivePreviewTabChange={onActivePreviewTabChange}
      />
    );

    await waitFor(() => expect(onPreviewTabsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ sessionId: secondSession.id, fileName: "todo.txt" })
    ]));
    expect(previewFile).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["CRLF", "one\r\ntwo", "crlf" as const],
    ["CR", "one\rtwo", "cr" as const],
    ["LF", "one\ntwo", "lf" as const]
  ])("does not mark an untouched %s file as dirty", async (_label, content, eol) => {
    const previewFile = vi.fn(async () => ({
      kind: "text" as const,
      size: Buffer.byteLength(content),
      content,
      version: "version-1",
      encoding: "utf-8" as const,
      bom: false,
      eol
    }));
    window.remoteFileApi = {
      getHome: vi.fn(async () => rootPath),
      list: vi.fn(async () => [{ name: "notes.txt", path: filePath, type: "file", size: content.length, modifiedAt: 0 }]),
      previewFile,
      releasePreview: vi.fn(async () => true),
      onDownloadProgress: vi.fn(() => () => undefined),
      watchDirectories: vi.fn(async () => true),
      unwatchDirectories: vi.fn(async () => true),
      onChanged: vi.fn(() => () => undefined),
      onWatchError: vi.fn(() => () => undefined)
    } as unknown as RemoteFileApi;
    const session: TerminalSession = {
      id: "session-1",
      title: "Windows",
      shell: "powershell.exe",
      cwd: rootPath,
      createdAt: 1,
      type: "windows"
    };
    const previewHost = document.createElement("div");
    document.body.append(previewHost);
    let activePreviewTabId: string | null = null;
    const onActivePreviewTabChange = vi.fn((tabId: string | null) => {
      activePreviewTabId = tabId;
    });
    const onDirtyChange = vi.fn();
    const onPreviewTabsChange = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = render(
      <RemoteFilePanel
        session={session}
        previewHost={previewHost}
        activePreviewTabId={activePreviewTabId}
        onActivePreviewTabChange={onActivePreviewTabChange}
        onDirtyChange={onDirtyChange}
        onPreviewTabsChange={onPreviewTabsChange}
      />
    );

    fireEvent.doubleClick((await screen.findByTitle(filePath)).closest("button")!);
    await waitFor(() => expect(previewFile).toHaveBeenCalledTimes(1));
    view.rerender(
      <RemoteFilePanel
        session={session}
        previewHost={previewHost}
        activePreviewTabId={activePreviewTabId}
        onActivePreviewTabChange={onActivePreviewTabChange}
        onDirtyChange={onDirtyChange}
        onPreviewTabsChange={onPreviewTabsChange}
      />
    );

    await waitFor(() => expect(previewHost.querySelector(".cm-editor")).not.toBeNull());
    await waitFor(() => expect(onPreviewTabsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ fileName: "notes.txt", dirty: false })
    ]));
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    expect(previewHost.querySelector(".remote-preview-dirty")).toBeNull();

    const previewChangeCount = onPreviewTabsChange.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "重新加载文件" }));
    await waitFor(() => expect(previewFile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onPreviewTabsChange.mock.calls.length).toBeGreaterThan(previewChangeCount));
    expect(onPreviewTabsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ fileName: "notes.txt", dirty: false })
    ]);
    expect(confirm).not.toHaveBeenCalled();
    expect(previewHost.querySelector(".remote-preview-dirty")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(confirm).not.toHaveBeenCalled();
    previewHost.remove();
  });

  it("reports the full asynchronous native drag lifecycle", async () => {
    let finishDrag!: (result: { canceled: false; localPath: string }) => void;
    const startDownloadDrag = vi.fn(() => new Promise<{ canceled: false; localPath: string }>((resolve) => {
      finishDrag = resolve;
    }));
    window.remoteFileApi = {
      getHome: vi.fn(async () => rootPath),
      list: vi.fn(async () => [{ name: "notes.txt", path: filePath, type: "file", size: 5, modifiedAt: 0 }]),
      startDownloadDrag,
      cancelDownload: vi.fn(async () => true),
      onDownloadProgress: vi.fn(() => () => undefined),
      watchDirectories: vi.fn(async () => true),
      unwatchDirectories: vi.fn(async () => true),
      onChanged: vi.fn(() => () => undefined),
      onWatchError: vi.fn(() => () => undefined)
    } as unknown as RemoteFileApi;
    const session: TerminalSession = {
      id: "session-1",
      title: "Windows",
      shell: "powershell.exe",
      cwd: rootPath,
      createdAt: 1,
      type: "windows"
    };
    const starts = vi.fn();
    const ends = vi.fn();
    document.addEventListener(INPUT_INTERRUPTION_START_EVENT, starts);
    document.addEventListener(INPUT_INTERRUPTION_END_EVENT, ends);

    render(<RemoteFilePanel session={session} />);

    const notes = await screen.findByTitle(filePath);
    fireEvent.dragStart(notes.closest("button")!);
    await waitFor(() => expect(startDownloadDrag).toHaveBeenCalledTimes(1));
    expect(starts).toHaveBeenCalledTimes(1);
    expect(ends).not.toHaveBeenCalled();

    finishDrag({ canceled: false, localPath: "C:\\Temp\\notes.txt" });
    await waitFor(() => expect(ends).toHaveBeenCalledTimes(1));

    document.removeEventListener(INPUT_INTERRUPTION_START_EVENT, starts);
    document.removeEventListener(INPUT_INTERRUPTION_END_EVENT, ends);
  });

  it("ends the native drag lifecycle when preparation fails", async () => {
    const startDownloadDrag = vi.fn(async () => {
      throw new Error("download failed");
    });
    window.remoteFileApi = {
      getHome: vi.fn(async () => rootPath),
      list: vi.fn(async () => [{ name: "notes.txt", path: filePath, type: "file", size: 5, modifiedAt: 0 }]),
      startDownloadDrag,
      cancelDownload: vi.fn(async () => true),
      onDownloadProgress: vi.fn(() => () => undefined),
      watchDirectories: vi.fn(async () => true),
      unwatchDirectories: vi.fn(async () => true),
      onChanged: vi.fn(() => () => undefined),
      onWatchError: vi.fn(() => () => undefined)
    } as unknown as RemoteFileApi;
    const session: TerminalSession = {
      id: "session-1",
      title: "Windows",
      shell: "powershell.exe",
      cwd: rootPath,
      createdAt: 1,
      type: "windows"
    };
    const starts = vi.fn();
    const ends = vi.fn();
    document.addEventListener(INPUT_INTERRUPTION_START_EVENT, starts);
    document.addEventListener(INPUT_INTERRUPTION_END_EVENT, ends);

    render(<RemoteFilePanel session={session} />);

    const notes = await screen.findByTitle(filePath);
    fireEvent.dragStart(notes.closest("button")!);

    await waitFor(() => expect(ends).toHaveBeenCalledTimes(1));
    expect(startDownloadDrag).toHaveBeenCalledTimes(1);
    expect(starts).toHaveBeenCalledTimes(1);

    document.removeEventListener(INPUT_INTERRUPTION_START_EVENT, starts);
    document.removeEventListener(INPUT_INTERRUPTION_END_EVENT, ends);
  });

  it("opens relative Markdown links in another preview tab without navigating the renderer", async () => {
    const markdownPath = `${rootPath}\\README.md`;
    const docsPath = `${rootPath}\\docs`;
    const guidePath = `${docsPath}\\Setup Guide.md`;
    const previewFile = vi.fn(async (_sessionId: string, path: string) => ({
      kind: "text" as const,
      path,
      content: path === markdownPath ? "[Setup guide](docs/Setup%20Guide.md#install)" : "Guide content"
    }));
    window.remoteFileApi = {
      getHome: vi.fn(async () => rootPath),
      list: vi.fn(async (_sessionId: string, path: string) => path === rootPath
        ? [
            { name: "README.md", path: markdownPath, type: "file", size: 50, modifiedAt: 0 },
            { name: "docs", path: docsPath, type: "directory", size: 0, modifiedAt: 0 }
          ]
        : [{ name: "Setup Guide.md", path: guidePath, type: "file", size: 20, modifiedAt: 0 }]),
      previewFile,
      onDownloadProgress: vi.fn(() => () => undefined),
      watchDirectories: vi.fn(async () => true),
      unwatchDirectories: vi.fn(async () => true),
      onChanged: vi.fn(() => () => undefined),
      onWatchError: vi.fn(() => () => undefined)
    } as unknown as RemoteFileApi;
    const session: TerminalSession = {
      id: "session-1",
      title: "Windows",
      shell: "powershell.exe",
      cwd: rootPath,
      createdAt: 1,
      type: "windows"
    };
    const previewHost = document.createElement("div");
    document.body.append(previewHost);
    let activePreviewTabId: string | null = null;
    const onActivePreviewTabChange = vi.fn((tabId: string | null) => {
      activePreviewTabId = tabId;
    });
    const view = render(
      <RemoteFilePanel
        session={session}
        previewHost={previewHost}
        activePreviewTabId={activePreviewTabId}
        onActivePreviewTabChange={onActivePreviewTabChange}
      />
    );

    fireEvent.doubleClick((await screen.findByTitle(markdownPath)).closest("button")!);
    await waitFor(() => expect(previewFile).toHaveBeenCalledWith(session.id, markdownPath));
    view.rerender(
      <RemoteFilePanel
        session={session}
        previewHost={previewHost}
        activePreviewTabId={activePreviewTabId}
        onActivePreviewTabChange={onActivePreviewTabChange}
      />
    );

    const link = await screen.findByRole("link", { name: "Setup guide" });
    expect(fireEvent.click(link)).toBe(false);
    await waitFor(() => expect(previewFile).toHaveBeenCalledWith(session.id, guidePath));
    expect(onActivePreviewTabChange).toHaveBeenLastCalledWith(`${session.id}:${guidePath}`);
    previewHost.remove();
  });

  it("keeps external and unsafe Markdown links from navigating the renderer", async () => {
    const markdownPath = `${rootPath}\\README.md`;
    const previewFile = vi.fn(async (_sessionId: string, path: string) => ({
      kind: "text" as const,
      path,
      content: "[Website](https://example.com/docs) [Outside](../outside.md) [Email](mailto:test@example.com)"
    }));
    const openExternal = vi.fn(async (_url: string) => undefined);
    window.externalLinkApi = { open: openExternal };
    window.remoteFileApi = {
      getHome: vi.fn(async () => rootPath),
      list: vi.fn(async () => [{ name: "README.md", path: markdownPath, type: "file", size: 50, modifiedAt: 0 }]),
      previewFile,
      onDownloadProgress: vi.fn(() => () => undefined),
      watchDirectories: vi.fn(async () => true),
      unwatchDirectories: vi.fn(async () => true),
      onChanged: vi.fn(() => () => undefined),
      onWatchError: vi.fn(() => () => undefined)
    } as unknown as RemoteFileApi;
    const session: TerminalSession = {
      id: "session-1",
      title: "Windows",
      shell: "powershell.exe",
      cwd: rootPath,
      createdAt: 1,
      type: "windows"
    };
    const previewHost = document.createElement("div");
    document.body.append(previewHost);
    let activePreviewTabId: string | null = null;
    const onActivePreviewTabChange = (tabId: string | null) => {
      activePreviewTabId = tabId;
    };
    const view = render(
      <RemoteFilePanel
        session={session}
        previewHost={previewHost}
        activePreviewTabId={activePreviewTabId}
        onActivePreviewTabChange={onActivePreviewTabChange}
      />
    );

    fireEvent.doubleClick((await screen.findByTitle(markdownPath)).closest("button")!);
    await waitFor(() => expect(previewFile).toHaveBeenCalledTimes(1));
    view.rerender(
      <RemoteFilePanel
        session={session}
        previewHost={previewHost}
        activePreviewTabId={activePreviewTabId}
        onActivePreviewTabChange={onActivePreviewTabChange}
      />
    );

    expect(fireEvent.click(await screen.findByRole("link", { name: "Website" }))).toBe(false);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
    expect(fireEvent.click(screen.getByRole("link", { name: "Outside" }))).toBe(false);
    expect(fireEvent.click(screen.getByRole("link", { name: "Email" }))).toBe(false);
    await waitFor(() => expect(previewFile).toHaveBeenCalledTimes(1));
    expect(openExternal).toHaveBeenCalledTimes(1);
    previewHost.remove();
  });
});
