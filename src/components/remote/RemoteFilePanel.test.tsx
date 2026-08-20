// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteFilePanel } from "./RemoteFilePanel";
import type { RemoteFileApi, RemoteFileEntry, TerminalSession } from "../../vite-env";

const rootPath = "C:\\workspace";
const childPath = `${rootPath}\\patches`;

function directory(name: string, path: string): RemoteFileEntry {
  return { name, path, type: "directory", size: 0, modifiedAt: 0 };
}

function createRemoteFileApi(): RemoteFileApi {
  return {
    getHome: vi.fn(async () => rootPath),
    list: vi.fn(async (_sessionId: string, path: string) => {
      if (path === rootPath) return [directory("patches", childPath)];
      if (path === childPath) return [directory("01_SCHEMA", `${childPath}\\01_SCHEMA`)];
      return [];
    }),
    onDownloadProgress: vi.fn(() => () => undefined),
    watchDirectories: vi.fn(async () => true),
    unwatchDirectories: vi.fn(async () => true),
    onChanged: vi.fn(() => () => undefined),
    onWatchError: vi.fn(() => () => undefined),
    moveEntry: vi.fn(async () => ({ status: "conflict" }))
  } as unknown as RemoteFileApi;
}

describe("RemoteFilePanel directory navigation", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("finishes expanding a directory after navigation history changes", async () => {
    window.remoteFileApi = createRemoteFileApi();
    const session: TerminalSession = {
      id: "session-1",
      title: "Windows",
      shell: "powershell.exe",
      cwd: rootPath,
      createdAt: 1,
      type: "windows"
    };

    render(<RemoteFilePanel session={session} />);

    const patches = await screen.findByTitle(childPath);
    fireEvent.click(patches.closest("button")!);

    await waitFor(() => {
      expect(screen.getByTitle(`${childPath}\\01_SCHEMA`)).toBeTruthy();
    });
  });

  it("shows create actions in the directory context menu instead of the toolbar", async () => {
    window.remoteFileApi = createRemoteFileApi();
    const session: TerminalSession = {
      id: "session-1",
      title: "Windows",
      shell: "powershell.exe",
      cwd: rootPath,
      createdAt: 1,
      type: "windows"
    };

    render(<RemoteFilePanel session={session} />);

    expect(screen.queryByRole("button", { name: "新建文件" })).toBeNull();
    expect(screen.queryByRole("button", { name: "新建文件夹" })).toBeNull();

    const patches = await screen.findByTitle(childPath);
    fireEvent.contextMenu(patches.closest("button")!, { clientX: 20, clientY: 30 });

    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "新建文件" })).toBeTruthy();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "新建文件夹" }));

    expect(screen.getByPlaceholderText("新建文件夹")).toBeTruthy();
  });

  it("closes rename editing without requesting a move when the name is unchanged", async () => {
    const remoteFileApi = createRemoteFileApi();
    window.remoteFileApi = remoteFileApi;
    const session: TerminalSession = {
      id: "session-1",
      title: "Windows",
      shell: "powershell.exe",
      cwd: rootPath,
      createdAt: 1,
      type: "windows"
    };

    render(<RemoteFilePanel session={session} />);

    const patches = await screen.findByTitle(childPath);
    fireEvent.contextMenu(patches.closest("button")!, { clientX: 20, clientY: 30 });
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "重命名" }));

    const input = screen.getByDisplayValue("patches");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.queryByDisplayValue("patches")).toBeNull());
    expect(remoteFileApi.moveEntry).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "目标中已存在同名项目" })).toBeNull();
  });

  it("keeps toolbar, path, sorting, and directory filtering available in the compact layout", async () => {
    const remoteFileApi = createRemoteFileApi();
    window.remoteFileApi = remoteFileApi;
    const session: TerminalSession = {
      id: "session-1",
      title: "Windows",
      shell: "powershell.exe",
      cwd: rootPath,
      createdAt: 1,
      type: "windows"
    };
    const updateSession = vi.fn(async () => session);
    window.terminalApi = { updateSession } as unknown as typeof window.terminalApi;

    const { container } = render(<RemoteFilePanel session={session} onSearchRequest={vi.fn()} />);

    await screen.findByTitle(childPath);
    expect(within(container.querySelector(".remote-file-actions")!).getAllByRole("button")).toHaveLength(6);

    const pathInput = container.querySelector<HTMLInputElement>(".remote-file-path input")!;
    fireEvent.change(pathInput, { target: { value: childPath } });
    fireEvent.keyDown(pathInput, { key: "Enter" });
    await waitFor(() => expect(remoteFileApi.list).toHaveBeenCalledWith(session.id, childPath));

    const sortSelect = container.querySelector<HTMLSelectElement>(".remote-file-sort")!;
    fireEvent.change(sortSelect, { target: { value: "name:desc" } });
    expect(updateSession).toHaveBeenCalledWith(session.id, { fileSort: { key: "name", direction: "desc" } });

    const searchInput = container.querySelector<HTMLInputElement>(".remote-file-search input")!;
    fireEvent.change(searchInput, { target: { value: "missing" } });
    await waitFor(() => expect(screen.queryByTitle(`${childPath}\\01_SCHEMA`)).toBeNull());
    fireEvent.change(searchInput, { target: { value: "01_SCHEMA" } });
    expect(await screen.findByTitle(`${childPath}\\01_SCHEMA`)).toBeTruthy();
  });

  it("uses an in-app confirmation dialog for deletion instead of blocking the Electron window", async () => {
    const remoteFileApi = createRemoteFileApi();
    remoteFileApi.deleteEntry = vi.fn(async (): Promise<{ mode: "trash" }> => ({ mode: "trash" }));
    window.remoteFileApi = remoteFileApi;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const session: TerminalSession = {
      id: "session-1",
      title: "Windows",
      shell: "powershell.exe",
      cwd: rootPath,
      createdAt: 1,
      type: "windows"
    };

    const { container } = render(<RemoteFilePanel session={session} />);

    const patches = await screen.findByTitle(childPath);
    fireEvent.contextMenu(patches.closest("button")!, { clientX: 20, clientY: 30 });
    const deleteButton = screen.getByRole("menu").querySelector(".lucide-trash-2")?.closest("button");
    expect(deleteButton).toBeTruthy();
    fireEvent.click(deleteButton!);

    expect(confirm).not.toHaveBeenCalled();
    const dialog = container.querySelector(".file-operation-dialog");
    expect(dialog).toBeTruthy();
    expect(remoteFileApi.deleteEntry).not.toHaveBeenCalled();
    fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "取消" }));
    expect(container.querySelector(".file-operation-dialog")).toBeNull();
    expect(remoteFileApi.deleteEntry).not.toHaveBeenCalled();
  });

  it("restores ordinary and terminal focus before an asynchronous deletion finishes", async () => {
    let finishDelete!: (result: { mode: "trash" }) => void;
    const remoteFileApi = createRemoteFileApi();
    remoteFileApi.deleteEntry = vi.fn(() => new Promise<{ mode: "trash" }>((resolve) => {
      finishDelete = resolve;
    }));
    window.remoteFileApi = remoteFileApi;
    const session: TerminalSession = {
      id: "session-1",
      title: "Windows",
      shell: "powershell.exe",
      cwd: rootPath,
      createdAt: 1,
      type: "windows"
    };

    const { container } = render(
      <>
        <textarea className="xterm-helper-textarea" aria-label="terminal input" />
        <RemoteFilePanel session={session} />
      </>
    );

    const patches = await screen.findByTitle(childPath);
    fireEvent.contextMenu(patches.closest("button")!, { clientX: 20, clientY: 30 });
    const deleteButton = screen.getByRole("menu").querySelector(".lucide-trash-2")?.closest("button");
    fireEvent.click(deleteButton!);
    const dialog = screen.getByRole("dialog", { name: "删除" });
    fireEvent.click(dialog.querySelector<HTMLButtonElement>("button.danger")!);

    expect(screen.queryByRole("dialog", { name: "删除" })).toBeNull();
    expect(remoteFileApi.deleteEntry).toHaveBeenCalledWith(session.id, childPath);

    const pathInput = container.querySelector<HTMLInputElement>(".remote-file-path input")!;
    pathInput.focus();
    expect(document.activeElement).toBe(pathInput);
    const terminalInput = screen.getByLabelText("terminal input");
    terminalInput.focus();
    expect(document.activeElement).toBe(terminalInput);

    finishDelete({ mode: "trash" });
    await waitFor(() => expect(remoteFileApi.list).toHaveBeenCalledTimes(2));
  });

});
