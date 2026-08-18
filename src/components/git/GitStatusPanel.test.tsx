// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { GitDiffResult, GitRepositorySnapshot, TerminalSession } from "../../vite-env";
import { GitStatusPanel } from "./GitStatusPanel";

function createSession(id: string): TerminalSession {
  return {
    id,
    templateId: `template-${id}`,
    type: "windows",
    title: id,
    shell: "powershell.exe",
    cwd: `C:\\work\\${id}`,
    createdAt: Date.now()
  };
}

function createSnapshot(cwd: string, mode: "mixed" | "staged" | "working" | "conflict" | "clean" = "mixed"): GitRepositorySnapshot {
  const files = mode === "clean" ? [] : mode === "staged" ? [{
    status: "M",
    label: "M",
    indexStatus: "M",
    worktreeStatus: " ",
    conflicted: false,
    path: "staged.ts"
  }] : mode === "working" ? [{
    status: "M",
    label: "M",
    indexStatus: ".",
    worktreeStatus: "M",
    conflicted: false,
    path: "working.ts"
  }] : mode === "conflict" ? [{
    status: "U",
    label: "U",
    indexStatus: "U",
    worktreeStatus: "U",
    conflicted: true,
    path: "conflict.ts"
  }] : [{
    status: "M",
    label: "M",
    indexStatus: "M",
    worktreeStatus: "M",
    conflicted: false,
    path: "both.ts"
  }, {
    status: "?",
    label: "?",
    indexStatus: "?",
    worktreeStatus: "?",
    conflicted: false,
    path: "scratch.txt"
  }];
  return {
    cwd,
    status: {
      cwd,
      clean: files.length === 0,
      files,
      branch: {
        name: "main",
        oid: "abcdef123456",
        detached: false,
        unborn: false,
        upstream: { name: "origin/main", remote: "origin", branch: "main" },
        ahead: 1,
        behind: 2
      }
    },
    branches: {
      cwd,
      branches: [{ name: "main", kind: "local", current: true, commit: "abcdef1", relativeTime: "now" }]
    },
    remotes: { cwd, remotes: ["origin"] },
    stashes: { cwd, stashes: [] },
    operationState: null
  };
}

function createGitApi(snapshotBySession: Record<string, GitRepositorySnapshot>) {
  return {
    changeDirectory: vi.fn(async (sessionId: string, _cwd: string) => ({
      cwd: snapshotBySession[sessionId].cwd,
      history: [] as string[],
      snapshot: snapshotBySession[sessionId],
      status: snapshotBySession[sessionId].status,
      branches: snapshotBySession[sessionId].branches,
      stashes: snapshotBySession[sessionId].stashes
    })),
    getSnapshot: vi.fn(async (sessionId: string) => snapshotBySession[sessionId]),
    discoverRepository: vi.fn(async (sessionId: string) => ({ cwd: snapshotBySession[sessionId].cwd })),
    discoverRepositories: vi.fn(async (sessionId: string) => ({
      root: snapshotBySession[sessionId].cwd,
      repositories: [{ cwd: snapshotBySession[sessionId].cwd, name: sessionId, relativePath: "." }]
    })),
    chooseDirectory: vi.fn(async () => ({ canceled: true as const })),
    getStatus: vi.fn(async (sessionId: string) => snapshotBySession[sessionId].status),
    getDiff: vi.fn(async (_sessionId: string, request: { scope: string }) => ({
      cwd: "C:\\work",
      path: "",
      status: "M",
      scope: request.scope as GitDiffResult["scope"],
      kind: "text" as const,
      rows: [{ type: "modify" as const, oldLineNumber: 1, newLineNumber: 1, oldText: "old", newText: "new" }],
      truncated: false,
      capturedBytes: 10
    })),
    getBranches: vi.fn(),
    getRemotes: vi.fn(),
    checkoutBranch: vi.fn(async () => ({ ok: true, message: "checked out" })),
    createBranch: vi.fn(async () => ({ ok: true, message: "created" })),
    getStashes: vi.fn(),
    getHistory: vi.fn(async () => ({
      cwd: "C:\\work",
      commits: [{ oid: "abcdef123456", shortOid: "abcdef1", authorName: "Ada", authorEmail: "ada@example.test", authoredAt: Date.now(), subject: "Recent change", decorations: ["HEAD -> main"] }],
      hasMore: false,
      nextSkip: 1
    })),
    stageFiles: vi.fn(async () => ({ ok: true, message: "staged" })),
    stageAll: vi.fn(async () => ({ ok: true, message: "staged all" })),
    unstageFiles: vi.fn(async () => ({ ok: true, message: "unstaged" })),
    unstageAll: vi.fn(async () => ({ ok: true, message: "unstaged all" })),
    discardWorkingTree: vi.fn(async () => ({ ok: true, message: "discarded" })),
    commit: vi.fn(async () => ({ ok: true, message: "committed" })),
    fetch: vi.fn(async () => ({ ok: true, message: "fetched" })),
    pull: vi.fn(async () => ({ ok: true, message: "pulled" })),
    push: vi.fn(async () => ({ ok: true, message: "pushed" })),
    stashChanges: vi.fn(async () => ({ ok: true, message: "stashed" })),
    applyStash: vi.fn(async () => ({ ok: true, message: "applied" })),
    popStash: vi.fn(async () => ({ ok: true, message: "popped" })),
    dropStash: vi.fn(async () => ({ ok: true, message: "dropped" })),
    revertFile: vi.fn(async () => ({ ok: true, message: "discarded" })),
    cancelOperation: vi.fn(async () => true)
  };
}

function renderPanel(session: TerminalSession) {
  return render(<I18nProvider locale="zh-CN"><GitStatusPanel session={session} /></I18nProvider>);
}

describe("GitStatusPanel", () => {
  beforeEach(() => {
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows staged and working copies separately and confirms permanent untracked deletion", async () => {
    const session = createSession("mixed-panel");
    const api = createGitApi({ [session.id]: createSnapshot(session.cwd, "mixed") });
    window.gitApi = api;
    const user = userEvent.setup();
    renderPanel(session);

    expect(await screen.findByText("已暂存的更改")).toBeTruthy();
    expect(screen.getByText("未暂存的更改")).toBeTruthy();
    expect(screen.getAllByText("both.ts")).toHaveLength(2);

    const scratchRow = screen.getByText("scratch.txt").closest(".git-status-row");
    expect(scratchRow).toBeTruthy();
    await user.click(scratchRow!.querySelector<HTMLButtonElement>(".git-status-revert")!);
    expect(await screen.findByText(/永久删除未跟踪文件 scratch\.txt/)).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "取消" });
    expect(document.activeElement).toBe(cancel);
    await user.click(screen.getByRole("button", { name: "放弃" }));
    await waitFor(() => expect(api.discardWorkingTree).toHaveBeenCalledWith(session.id, expect.objectContaining({ path: "scratch.txt" }), expect.any(String)));
  });

  it("retains commit drafts per session and clears only after a successful commit", async () => {
    const first = createSession("draft-one");
    const second = createSession("draft-two");
    const api = createGitApi({
      [first.id]: createSnapshot(first.cwd, "staged"),
      [second.id]: createSnapshot(second.cwd, "staged")
    });
    window.gitApi = api;
    const user = userEvent.setup();
    const view = renderPanel(first);

    const subject = await screen.findByPlaceholderText("提交标题");
    await user.type(subject, "First draft");
    view.rerender(<I18nProvider locale="zh-CN"><GitStatusPanel session={second} /></I18nProvider>);
    expect((await screen.findByPlaceholderText("提交标题") as HTMLInputElement).value).toBe("");
    view.rerender(<I18nProvider locale="zh-CN"><GitStatusPanel session={first} /></I18nProvider>);
    expect((await screen.findByPlaceholderText("提交标题") as HTMLInputElement).value).toBe("First draft");

    await user.click(screen.getByRole("button", { name: /提交已暂存更改/ }));
    await waitFor(() => expect(api.commit).toHaveBeenCalledWith(first.id, expect.objectContaining({ subject: "First draft" }), expect.any(String)));
    await waitFor(() => expect((screen.getByPlaceholderText("提交标题") as HTMLInputElement).value).toBe(""));
  });

  it("does not treat porcelain-v2 dots as staged changes", async () => {
    const session = createSession("working-only");
    window.gitApi = createGitApi({ [session.id]: createSnapshot(session.cwd, "working") });
    const user = userEvent.setup();
    renderPanel(session);

    await screen.findByText("working.ts");
    const commitDisclosure = screen.getByRole("button", { name: "展开提交" });
    expect(commitDisclosure.getAttribute("aria-expanded")).toBe("false");
    await user.click(commitDisclosure);
    const commitButton = screen.getByRole("button", { name: /提交已暂存更改/ });
    expect((commitButton as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelectorAll(".git-change-group")).toHaveLength(1);
  });

  it("discovers repositories automatically and refreshes branches after repository selection", async () => {
    const session = createSession("aggregate-panel");
    const alphaCwd = `${session.cwd}\\alpha`;
    const betaCwd = `${session.cwd}\\beta`;
    const alpha = createSnapshot(alphaCwd, "clean");
    const beta = createSnapshot(betaCwd, "clean");
    beta.status.branch.name = "develop";
    beta.branches.branches = [{ name: "develop", kind: "local", current: true, commit: "fedcba9", relativeTime: "now" }];
    const api = createGitApi({ [session.id]: alpha });
    api.discoverRepositories.mockResolvedValue({
      root: session.cwd,
      repositories: [
        { cwd: alphaCwd, name: "alpha", relativePath: "alpha" },
        { cwd: betaCwd, name: "beta", relativePath: "beta" }
      ]
    });
    api.changeDirectory.mockImplementation(async (_sessionId: string, cwd: string) => {
      const snapshot = cwd === betaCwd ? beta : alpha;
      return { cwd, history: [cwd], snapshot, status: snapshot.status, branches: snapshot.branches, stashes: snapshot.stashes };
    });
    window.gitApi = api;
    const user = userEvent.setup();
    renderPanel(session);

    const repositorySelect = await screen.findByRole("combobox", { name: "选择 Git 仓库" });
    await waitFor(() => expect(api.changeDirectory).toHaveBeenCalledWith(session.id, alphaCwd));
    await user.click(repositorySelect);
    await user.click(await screen.findByRole("option", { name: "beta — beta" }));

    await waitFor(() => expect(api.changeDirectory).toHaveBeenLastCalledWith(session.id, betaCwd));
    expect(await screen.findByText("* develop")).toBeTruthy();
  });

  it("shows an empty state when the current directory has no immediate repositories", async () => {
    const session = createSession("empty-aggregate");
    const api = createGitApi({ [session.id]: createSnapshot(session.cwd, "clean") });
    api.discoverRepositories.mockResolvedValue({ root: session.cwd, repositories: [] });
    window.gitApi = api;
    renderPanel(session);

    expect(await screen.findByText("当前目录及一级子目录中未发现 Git 仓库")).toBeTruthy();
    expect(api.changeDirectory).not.toHaveBeenCalled();
  });

  it("smart-opens exceptional repository, sync, and commit sections", async () => {
    const session = createSession("smart-sections");
    const snapshot = createSnapshot(session.cwd, "staged");
    snapshot.status.branch.detached = true;
    snapshot.status.branch.upstream = undefined;
    window.gitApi = createGitApi({ [session.id]: snapshot });
    renderPanel(session);

    expect(await screen.findByRole("button", { name: "收起仓库与分支" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "收起同步" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "收起提交" })).toBeTruthy();
    expect(screen.getByPlaceholderText("输入 Git 仓库绝对路径")).toBeTruthy();
    expect(screen.getByPlaceholderText("提交标题")).toBeTruthy();
  });

  it("remembers manual section choices per repository for the current process", async () => {
    const session = createSession("remember-sections");
    const snapshots: Record<string, GitRepositorySnapshot> = { [session.id]: createSnapshot(session.cwd, "working") };
    snapshots[session.id].status.branch.ahead = 0;
    snapshots[session.id].status.branch.behind = 0;
    window.gitApi = createGitApi(snapshots);
    const user = userEvent.setup();

    const firstView = renderPanel(session);
    await user.click(await screen.findByRole("button", { name: "展开提交" }));
    expect(screen.getByPlaceholderText("提交标题")).toBeTruthy();
    firstView.unmount();

    const rememberedView = renderPanel(session);
    expect(await screen.findByRole("button", { name: "收起提交" })).toBeTruthy();
    expect(screen.getByPlaceholderText("提交标题")).toBeTruthy();
    rememberedView.unmount();

    const alternate = { ...session, gitCwd: `${session.cwd}-alternate` };
    snapshots[session.id] = createSnapshot(alternate.gitCwd, "working");
    snapshots[session.id].status.branch.ahead = 0;
    snapshots[session.id].status.branch.behind = 0;
    renderPanel(alternate);
    expect(await screen.findByRole("button", { name: "展开提交" })).toBeTruthy();
  });

  it("keeps conflicts in the primary changes list", async () => {
    const session = createSession("conflict-panel");
    window.gitApi = createGitApi({ [session.id]: createSnapshot(session.cwd, "conflict") });
    renderPanel(session);

    expect(await screen.findByText("conflict.ts")).toBeTruthy();
    expect(screen.getByText("冲突")).toBeTruthy();
    expect(screen.getByRole("button", { name: "展开提交" })).toBeTruthy();
  });

  it("loads current-HEAD history and opens a commit diff", async () => {
    const session = createSession("history-panel");
    const api = createGitApi({ [session.id]: createSnapshot(session.cwd, "clean") });
    window.gitApi = api;
    renderPanel(session);

    await screen.findByText("工作目录干净。");
    fireEvent.click(screen.getByRole("tab", { name: /历史/ }));
    expect(await screen.findByText("Recent change")).toBeTruthy();
    fireEvent.click(screen.getByText("Recent change"));
    await waitFor(() => expect(api.getDiff).toHaveBeenCalledWith(session.id, { scope: "commit", revision: "abcdef123456" }));
    expect(await screen.findByText(/abcdef1 Recent change/)).toBeTruthy();
  });
});
