// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INPUT_INTERRUPTION_END_EVENT, INPUT_INTERRUPTION_START_EVENT } from "../../hooks/inputRecovery";
import { RemoteFilePanel } from "./RemoteFilePanel";
import type { RemoteFileApi, TerminalSession } from "../../vite-env";

const rootPath = "C:\\workspace";
const filePath = `${rootPath}\\notes.txt`;

describe("RemoteFilePanel file activation", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
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
    fireEvent.click(notes.closest("button")!);
    await waitFor(() => expect(previewFile).toHaveBeenCalledTimes(1));
    const openedTabId = onActivePreviewTabChange.mock.calls[0]?.[0];
    expect(openedTabId).toBeTruthy();

    onActivePreviewTabChange.mockClear();
    fireEvent.click(notes.closest("button")!);

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
    fireEvent.click(notes.closest("button")!);
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
    fireEvent.click((await screen.findByTitle(secondFilePath)).closest("button")!);
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
});
