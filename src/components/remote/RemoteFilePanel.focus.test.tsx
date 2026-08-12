// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
