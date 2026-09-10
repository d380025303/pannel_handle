// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteFilePanel } from "./RemoteFilePanel";
import type { ClipboardApi, RemoteFileApi, RemoteFileEntry, TerminalSession } from "../../vite-env";

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

  it("ignores legacy file roots and does not expose a root change action", async () => {
    const remoteFileApi = createRemoteFileApi();
    window.remoteFileApi = remoteFileApi;
    const legacyRoot = "C:\\legacy-root";
    const session = {
      id: "session-1",
      title: "Windows",
      shell: "powershell.exe",
      cwd: rootPath,
      createdAt: 1,
      type: "windows",
      fileRoot: legacyRoot
    } as TerminalSession & { fileRoot: string };

    render(<RemoteFilePanel session={session} />);

    await waitFor(() => expect(remoteFileApi.list).toHaveBeenCalledWith(session.id, rootPath));
    expect(remoteFileApi.list).not.toHaveBeenCalledWith(session.id, legacyRoot);
    expect(screen.queryByRole("button", { name: "更换文件根目录" })).toBeNull();
  });

  it("navigates above the session working directory and accepts another absolute path", async () => {
    const outsidePath = "D:\\shared";
    const remoteFileApi = createRemoteFileApi();
    remoteFileApi.createEntry = vi.fn(async (_sessionId, parentPath, name) => ({
      status: "completed" as const,
      path: `${parentPath}\\${name}`,
      name
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

    const { container } = render(<RemoteFilePanel session={session} />);

    await screen.findByTitle(childPath);
    const parentButton = screen.getByRole("button", { name: "上级目录" }) as HTMLButtonElement;
    expect(parentButton.disabled).toBe(false);
    fireEvent.click(parentButton);
    await waitFor(() => expect(remoteFileApi.list).toHaveBeenCalledWith(session.id, "C:/"));

    const pathInput = container.querySelector<HTMLInputElement>(".remote-file-path input")!;
    fireEvent.change(pathInput, { target: { value: outsidePath } });
    fireEvent.keyDown(pathInput, { key: "Enter" });
    await waitFor(() => expect(remoteFileApi.list).toHaveBeenCalledWith(session.id, outsidePath));

    const outsideRoot = await waitFor(() => {
      const match = screen.getAllByTitle(outsidePath).find((element) => element.classList.contains("remote-file-name"));
      expect(match).toBeTruthy();
      return match!;
    });
    fireEvent.contextMenu(outsideRoot.closest("button")!, { clientX: 20, clientY: 30 });
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "新建文件夹" }));
    const createInput = screen.getByPlaceholderText("新建文件夹");
    fireEvent.change(createInput, { target: { value: "created" } });
    fireEvent.keyDown(createInput, { key: "Enter" });

    await waitFor(() => expect(remoteFileApi.createEntry).toHaveBeenCalledWith(
      session.id,
      outsidePath,
      "created",
      "directory",
      "cancel"
    ));
  });

  it("disables parent navigation only at a filesystem root", async () => {
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

    const { container } = render(<RemoteFilePanel session={session} />);
    await screen.findByTitle(childPath);
    const pathInput = container.querySelector<HTMLInputElement>(".remote-file-path input")!;
    fireEvent.change(pathInput, { target: { value: "C:\\" } });
    fireEvent.keyDown(pathInput, { key: "Enter" });

    await waitFor(() => expect(remoteFileApi.list).toHaveBeenCalledWith(session.id, "C:\\"));
    await waitFor(() => expect((screen.getByRole("button", { name: "上级目录" }) as HTMLButtonElement).disabled).toBe(true));
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

  it("copies the selected entry name from the context menu", async () => {
    window.remoteFileApi = createRemoteFileApi();
    const writeText = vi.fn(async () => true);
    window.clipboardApi = { writeText } as unknown as ClipboardApi;
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
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "复制文件名" }));

    expect(writeText).toHaveBeenCalledWith("patches");
    expect(writeText).not.toHaveBeenCalledWith(childPath);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens rename in a dialog and closes it without requesting a move when the name is unchanged", async () => {
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

    const dialog = screen.getByRole("dialog", { name: "重命名" });
    const input = within(dialog).getByDisplayValue("patches");
    expect(patches.closest("button")!.querySelector("input")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "重命名" })).toBeNull());
    expect(remoteFileApi.moveEntry).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "目标中已存在同名项目" })).toBeNull();
  });

  it("submits a changed name from the rename dialog", async () => {
    const remoteFileApi = createRemoteFileApi();
    remoteFileApi.moveEntry = vi.fn(async () => ({ status: "completed" as const, name: "renamed", path: `${rootPath}\\renamed` }));
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

    const dialog = screen.getByRole("dialog", { name: "重命名" });
    const input = within(dialog).getByDisplayValue("patches");
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "重命名" }));

    await waitFor(() => expect(remoteFileApi.moveEntry).toHaveBeenCalledWith(
      session.id,
      childPath,
      rootPath,
      "renamed",
      "cancel"
    ));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "重命名" })).toBeNull());
  });

  it("keeps the existing conflict choices after submitting a rename", async () => {
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

    const dialog = screen.getByRole("dialog", { name: "重命名" });
    fireEvent.change(within(dialog).getByDisplayValue("patches"), { target: { value: "renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "重命名" }));

    expect(await screen.findByRole("heading", { name: "目标中已存在同名项目" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "覆盖" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "自动重命名" })).toBeTruthy();
  });

  it("cancels the rename dialog from Escape, the cancel button, and the backdrop", async () => {
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
    const openRename = () => {
      fireEvent.contextMenu(patches.closest("button")!, { clientX: 20, clientY: 30 });
      fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "重命名" }));
    };

    openRename();
    fireEvent.keyDown(within(screen.getByRole("dialog", { name: "重命名" })).getByDisplayValue("patches"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "重命名" })).toBeNull();

    openRename();
    fireEvent.click(within(screen.getByRole("dialog", { name: "重命名" })).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "重命名" })).toBeNull();

    openRename();
    fireEvent.click(screen.getByRole("dialog", { name: "重命名" }).parentElement!);
    expect(screen.queryByRole("dialog", { name: "重命名" })).toBeNull();
    expect(remoteFileApi.moveEntry).not.toHaveBeenCalled();
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

  it("exposes the automatic chain-collapse toggle in the toolbar", async () => {
    window.remoteFileApi = createRemoteFileApi();
    const session: TerminalSession = {
      id: "session-1",
      title: "Windows",
      shell: "powershell.exe",
      cwd: rootPath,
      createdAt: 1,
      type: "windows"
    };
    const onToggle = vi.fn();

    const { rerender } = render(
      <RemoteFilePanel
        session={session}
        autoCollapseFileChains
        onToggleAutoCollapseFileChains={onToggle}
      />
    );

    const disableButton = await screen.findByRole("button", { name: "关闭自动折叠单目录链" });
    expect(disableButton.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(disableButton);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <RemoteFilePanel
        session={session}
        autoCollapseFileChains={false}
        onToggleAutoCollapseFileChains={onToggle}
      />
    );
    expect(screen.getByRole("button", { name: "开启自动折叠单目录链" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("does not preload the next single-directory level when automatic collapsing is disabled", async () => {
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

    render(<RemoteFilePanel session={session} autoCollapseFileChains={false} />);

    const patches = await screen.findByTitle(childPath);
    fireEvent.click(patches.closest("button")!);
    await screen.findByTitle(`${childPath}\\01_SCHEMA`);

    expect(remoteFileApi.list).not.toHaveBeenCalledWith(session.id, `${childPath}\\01_SCHEMA`);
  });

  it.each(["file", "directory"] as const)("removes a deleted %s while refresh is pending and keeps it removed if refresh fails", async (type) => {
    const api = createRemoteFileApi();
    const target = { ...directory("patches", childPath), type };
    let rejectRefresh!: (error: Error) => void;
    api.list = vi.fn().mockResolvedValueOnce([target]).mockImplementation(() => new Promise((_resolve, reject) => {
      rejectRefresh = reject;
    }));
    api.deleteEntry = vi.fn().mockResolvedValue({ mode: "trash" });
    window.remoteFileApi = api;
    render(<RemoteFilePanel session={{ id: "delete-session", title: "Windows", shell: "powershell.exe", cwd: rootPath, createdAt: 1, type: "windows" }} />);
    fireEvent.contextMenu((await screen.findByTitle(childPath)).closest("button")!);
    fireEvent.click(screen.getByRole("menu").querySelector(".lucide-trash-2")!.closest("button")!);
    fireEvent.click(screen.getByRole("dialog", { name: "删除" }).querySelector<HTMLButtonElement>("button.danger")!);
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByTitle(childPath)).toBeNull();
    await act(async () => rejectRefresh(new Error("refresh failed")));
    expect(screen.queryByTitle(childPath)).toBeNull();
    expect(screen.getAllByText("refresh failed").length).toBeGreaterThan(0);
  });

  it("keeps an entry when deletion fails", async () => {
    const api = createRemoteFileApi();
    api.deleteEntry = vi.fn().mockRejectedValue(new Error("delete failed"));
    window.remoteFileApi = api;
    render(<RemoteFilePanel session={{ id: "delete-session", title: "Windows", shell: "powershell.exe", cwd: rootPath, createdAt: 1, type: "windows" }} />);
    fireEvent.contextMenu((await screen.findByTitle(childPath)).closest("button")!);
    fireEvent.click(screen.getByRole("menu").querySelector(".lucide-trash-2")!.closest("button")!);
    fireEvent.click(screen.getByRole("dialog", { name: "删除" }).querySelector<HTMLButtonElement>("button.danger")!);
    await screen.findByText("delete failed");
    expect(screen.getByTitle(childPath)).toBeTruthy();
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("replaces a deleted tree root with its parent", async () => {
    const api = createRemoteFileApi();
    let finishDelete!: (result: { mode: "trash" }) => void;
    api.deleteEntry = vi.fn(() => new Promise<{ mode: "trash" }>((resolve) => { finishDelete = resolve; }));
    window.remoteFileApi = api;
    const { container } = render(<RemoteFilePanel session={{ id: "delete-session", title: "Windows", shell: "powershell.exe", cwd: rootPath, createdAt: 1, type: "windows" }} />);
    fireEvent.contextMenu((await screen.findByTitle(childPath)).closest("button")!);
    fireEvent.click(screen.getByRole("menu").querySelector(".lucide-trash-2")!.closest("button")!);
    fireEvent.click(screen.getByRole("dialog", { name: "删除" }).querySelector<HTMLButtonElement>("button.danger")!);
    const input = container.querySelector<HTMLInputElement>(".remote-file-path input")!;
    for (const path of ["D:/other", childPath]) {
      fireEvent.change(input, { target: { value: path } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(api.list).toHaveBeenCalledWith("delete-session", path));
      await waitFor(() => expect(container.querySelector(".remote-file-loading")).toBeNull());
    }
    api.list = vi.fn().mockResolvedValue([]);
    await act(async () => finishDelete({ mode: "trash" }));
    await waitFor(() => expect(api.list).toHaveBeenCalledWith("delete-session", "C:/workspace"));
    expect(input.value).toBe("C:/workspace");
    expect(screen.queryByTitle(childPath)).toBeNull();
  });

  it("does not restore a deleted expanded directory from a late listing response", async () => {
    const api = createRemoteFileApi();
    const nestedPath = `${childPath}\\nested.txt`;
    let finishListing!: (entries: RemoteFileEntry[]) => void;
    let deleted = false;
    api.list = vi.fn(async (_sessionId, path) => {
      if (path === rootPath) return deleted ? [] : [directory("patches", childPath)];
      return new Promise<RemoteFileEntry[]>((resolve) => { finishListing = resolve; });
    });
    api.deleteEntry = vi.fn(async () => { deleted = true; return { mode: "trash" as const }; });
    window.remoteFileApi = api;
    render(<RemoteFilePanel autoCollapseFileChains={false} session={{ id: "delete-session", title: "Windows", shell: "powershell.exe", cwd: rootPath, createdAt: 1, type: "windows" }} />);
    const row = (await screen.findByTitle(childPath)).closest("button")!;
    fireEvent.click(row);
    await waitFor(() => expect(api.list).toHaveBeenCalledWith("delete-session", childPath));
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("menu").querySelector(".lucide-trash-2")!.closest("button")!);
    fireEvent.click(screen.getByRole("dialog", { name: "删除" }).querySelector<HTMLButtonElement>("button.danger")!);
    await waitFor(() => expect(screen.queryByTitle(childPath)).toBeNull());
    await act(async () => finishListing([{ ...directory("nested.txt", nestedPath), type: "file" }]));
    expect(screen.queryByTitle(childPath)).toBeNull();
    expect(screen.queryByTitle(nestedPath)).toBeNull();
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
