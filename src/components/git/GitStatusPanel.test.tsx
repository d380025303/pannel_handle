// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { GitDiffResult, GitRepositorySnapshot, GitRepositoryTarget, GitWorkspaceSnapshot, TerminalSession } from "../../vite-env";
import { GitStatusPanel } from "./GitStatusPanel";
import { ProjectSearchModal } from "../remote/ProjectSearchModal";

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
    getWorkspaceSnapshot: vi.fn(async (sessionId: string): Promise<GitWorkspaceSnapshot> => ({
      root: snapshotBySession[sessionId].cwd,
      repositories: [{ cwd: snapshotBySession[sessionId].cwd, name: sessionId, relativePath: ".", snapshot: snapshotBySession[sessionId] }]
    })),
    getSnapshot: vi.fn(async (target: GitRepositoryTarget) => snapshotBySession[target.sessionId]),
    getStatus: vi.fn(async (target: GitRepositoryTarget) => snapshotBySession[target.sessionId].status),
    getDiff: vi.fn(async (_target: { sessionId: string; cwd: string }, request: { scope: string }): Promise<GitDiffResult> => ({
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
  it("cycles discard confirmation focus and restores its trigger on dismissal", async () => {
    const session = createSession("discard-focus");
    const api = createGitApi({ [session.id]: createSnapshot(session.cwd, "working") });
    window.gitApi = api;
    const user = userEvent.setup();
    renderPanel(session);
    const entry = await screen.findByTitle(/放弃.*working\.ts/);
    for (const dismissal of ["cancel", "escape", "overlay", "confirm"]) {
      await user.click(entry);
      const dialog = screen.getByRole("alertdialog");
      const cancel = screen.getByRole("button", { name: "取消" });
      const confirm = dialog.querySelector<HTMLButtonElement>("button.danger")!;
      expect(document.activeElement).toBe(cancel);
      for (const shift of [false, true]) {
        for (let index = 0; index < 4; index += 1) {
          await user.tab({ shift });
          expect(document.activeElement).toBe(index % 2 === 0 ? confirm : cancel);
        }
      }
      entry.focus();
      expect(document.activeElement).toBe(cancel);
      if (dismissal === "escape") await user.keyboard("{Escape}");
      else if (dismissal === "overlay") await user.click(dialog.parentElement!);
      else await user.click(dismissal === "confirm" ? confirm : cancel);
      expect(screen.queryByRole("alertdialog")).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(entry));
      expect(api.discardWorkingTree).toHaveBeenCalledTimes(dismissal === "confirm" ? 1 : 0);
    }
  });

  it("contains stash keyboard focus and restores the entry after closing", async () => {
    const session = createSession("stash-focus");
    const snapshot = createSnapshot(session.cwd, "working");
    snapshot.stashes.stashes = [{ ref: "stash@{0}", message: "Saved work", commit: "abcdef123", relativeTime: "now" }];
    window.gitApi = createGitApi({ [session.id]: snapshot });
    const user = userEvent.setup();
    renderPanel(session);
    const entry = await screen.findByRole("button", { name: "储藏 (1)" });
    for (const closeWithEscape of [true, false]) {
      await user.click(entry);
      const dialog = screen.getByRole("dialog");
      const close = screen.getByRole("button", { name: "关闭储藏列表" });
      expect(document.activeElement).toBe(close);
      for (const shift of [false, true]) {
        for (let index = 0; index < 8; index += 1) {
          await user.tab({ shift });
          expect(dialog.contains(document.activeElement)).toBe(true);
        }
      }
      entry.focus();
      expect(dialog.contains(document.activeElement)).toBe(true);
      if (closeWithEscape) await user.keyboard("{Escape}");
      else await user.click(close);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(entry);
    }
  }, 15000);

  it("keeps diff keyboard focus inside and restores the file button on Escape", async () => {
    const session = createSession("diff-focus");
    const api = createGitApi({ [session.id]: createSnapshot(session.cwd, "working") });
    let resolveDiff!: (result: GitDiffResult) => void;
    const result = await api.getDiff({ sessionId: session.id, cwd: session.cwd }, { scope: "working" });
    api.getDiff.mockImplementation(() => new Promise((resolve) => { resolveDiff = resolve; }));
    window.gitApi = api;
    const user = userEvent.setup();
    renderPanel(session);
    const fileButton = (await screen.findByText("working.ts")).closest("button")!;
    await user.click(fileButton);
    const dialog = screen.getByRole("dialog");
    const closeButton = screen.getByRole("button", { name: "关闭差异" });
    expect(document.activeElement).toBe(closeButton);
    await user.tab();
    expect(document.activeElement).toBe(closeButton);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(closeButton);
    resolveDiff(result);
    await screen.findByRole("textbox", { name: "搜索差异" });
    for (const shift of [false, true]) {
      for (let index = 0; index < 14; index += 1) {
        await user.tab({ shift });
        expect(dialog.contains(document.activeElement)).toBe(true);
      }
    }
    fileButton.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(fileButton);
  });

  it("closes only the diff on Escape and preserves the underlying project search", async () => {
    const session = createSession("search-diff-escape");
    window.gitApi = createGitApi({ [session.id]: createSnapshot(session.cwd, "working") });
    window.projectSearchApi = {
      listDirectories: vi.fn(async () => ({ workspaceRoot: session.cwd, path: session.cwd, directories: [] })),
      searchFiles: vi.fn(async () => ({ root: session.cwd, results: [{ name: "App.tsx", path: `${session.cwd}\\src\\App.tsx`, relativePath: "src/App.tsx" }] })),
      cancelFileSearch: vi.fn(async () => true)
    } as unknown as typeof window.projectSearchApi;
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<I18nProvider locale="zh-CN">
      <ProjectSearchModal mode="files" initialRoot={session.cwd} session={session} embedded onClose={onClose} onOpenPath={() => {}} />
      <GitStatusPanel session={session} />
    </I18nProvider>);
    const searchInput = screen.getAllByRole("textbox")[1];
    await user.type(searchInput, "App");
    await screen.findByRole("button", { name: /App\.tsx/ });
    await user.click((await screen.findByText("working.ts")).closest("button")!);
    const diffSearch = await screen.findByRole("textbox", { name: "搜索差异" });
    await user.click(diffSearch);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect((searchInput as HTMLInputElement).value).toBe("App");
    expect(screen.getByRole("button", { name: /App\.tsx/ })).toBeTruthy();
    await user.click(searchInput);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("labels the ours comparison base in the preview and search selector", async () => {
    const session = createSession("ours-diff");
    const api = createGitApi({ [session.id]: createSnapshot(session.cwd, "working") });
    api.getDiff.mockResolvedValue({
      cwd: session.cwd, path: "working.ts", status: "U", scope: "working", kind: "text",
      comparisonBase: "ours", rows: [{ type: "add", newLineNumber: 1, newText: "<<<<<<< HEAD" }],
      truncated: false, capturedBytes: 100
    });
    window.gitApi = api;
    const user = userEvent.setup();
    renderPanel(session);
    await user.click((await screen.findByText("working.ts")).closest("button")!);
    expect(await screen.findByRole("columnheader", { name: "我方（索引 stage 2）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "我方（索引 stage 2）" })).toBeTruthy();
  });

  beforeEach(() => {
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each(["long-line", "multiple-cells", "exact-limit", "ordinary"])(
    "bounds diff search highlights and preserves navigation for %s",
    async (scenario) => {
      const session = createSession(`search-${scenario}`);
      const api = createGitApi({ [session.id]: createSnapshot(session.cwd, "working") });
      const rows: GitDiffResult["rows"] = scenario === "multiple-cells"
        ? [0, 1].map((index) => ({ type: "modify", oldLineNumber: index + 1, newLineNumber: index + 1, oldText: "a".repeat(400), newText: "a".repeat(400) }))
        : [{ type: "add", newLineNumber: 1, newText: scenario === "long-line" ? "a".repeat(50000) : scenario === "exact-limit" ? "a".repeat(1000) : "Aa xx aA" }];
      api.getDiff.mockResolvedValue({
        cwd: session.cwd, path: "working.ts", status: "M", scope: "working", kind: "text",
        rows, truncated: false, capturedBytes: 50000
      });
      window.gitApi = api;
      const scrollIntoView = vi.fn();
      Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
      const user = userEvent.setup();
      const { container } = renderPanel(session);
      await user.click((await screen.findByText("working.ts")).closest("button")!);
      const input = await screen.findByRole("textbox", { name: "搜索差异" });
      const assertMatches = (count: number, truncated: boolean) => {
        expect(container.querySelectorAll("mark")).toHaveLength(count);
        expect(container.querySelector('[role="status"]') !== null).toBe(truncated);
        if (truncated) expect(screen.getByText(/匹配结果已截断/)).toBeTruthy();
        expect(container.querySelector(".git-diff-match-count")?.textContent).toBe(`1 / ${count}`);
      };
      fireEvent.change(input, { target: { value: "a" } });
      const count = scenario === "ordinary" ? 4 : 1000;
      assertMatches(count, scenario === "long-line" || scenario === "multiple-cells");
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
      expect(container.querySelector(".git-diff-match-count")?.textContent).toBe(`${count} / ${count}`);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(container.querySelector(".git-diff-match-count")?.textContent).toBe(`1 / ${count}`);
      expect(container.querySelectorAll("mark.active")).toHaveLength(1);
      expect(scrollIntoView).toHaveBeenCalled();
      fireEvent.change(input, { target: { value: "aa" } });
      assertMatches(scenario === "ordinary" ? 2 : scenario === "long-line" ? 1000 : scenario === "exact-limit" ? 500 : 800, scenario === "long-line");
      if (scenario === "multiple-cells") {
        await user.click(screen.getByRole("button", { name: "HEAD" }));
        assertMatches(400, false);
      }
      fireEvent.change(input, { target: { value: "missing" } });
      expect(container.querySelectorAll("mark")).toHaveLength(0);
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(container.querySelector(".git-diff-match-count")?.textContent).toBe("0 / 0");
      fireEvent.change(input, { target: { value: "" } });
      expect(container.querySelectorAll("mark")).toHaveLength(0);
      expect(container.querySelector(".git-diff-cell.new code")?.textContent).toBe(rows[0].newText);
    }
  );

  it.each(["R", "M", "C"])("unstages the correct paths for index status %s", async (indexStatus) => {
    const session = createSession("unstage-panel");
    const snapshot = createSnapshot(session.cwd, "staged");
    snapshot.status.files = [{
      status: indexStatus, label: indexStatus, indexStatus, worktreeStatus: ".",
      conflicted: false, path: "after.txt", oldPath: "before.txt"
    }];
    const api = createGitApi({ [session.id]: snapshot });
    window.gitApi = api;
    const user = userEvent.setup();

    renderPanel(session);
    await user.click(await screen.findByRole("button", { name: "取消暂存" }));

    await waitFor(() => expect(api.unstageFiles).toHaveBeenCalledWith(
      { sessionId: session.id, cwd: snapshot.cwd },
      indexStatus === "R" ? ["before.txt", "after.txt"] : ["after.txt"],
      expect.any(String)
    ));
  });

  it("shows every repository change and keeps clean repositories collapsed", async () => {
    const session = createSession("aggregate-panel");
    const alpha = createSnapshot(`${session.cwd}\\alpha`, "working");
    const beta = createSnapshot(`${session.cwd}\\beta`, "staged");
    const gamma = createSnapshot(`${session.cwd}\\gamma`, "clean");
    const api = createGitApi({ [session.id]: alpha });
    api.getWorkspaceSnapshot.mockResolvedValue({
      root: session.cwd,
      repositories: [
        { cwd: alpha.cwd, name: "alpha", relativePath: "alpha", snapshot: alpha },
        { cwd: beta.cwd, name: "beta", relativePath: "beta", snapshot: beta },
        { cwd: gamma.cwd, name: "gamma", relativePath: "gamma", snapshot: gamma }
      ]
    });
    window.gitApi = api;

    renderPanel(session);

    expect(await screen.findByText("working.ts")).toBeTruthy();
    expect(screen.getByText("staged.ts")).toBeTruthy();
    expect(screen.getByText("3 个仓库 · 2 项修改")).toBeTruthy();
    expect(screen.getByRole("button", { name: /gamma/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("routes file operations to the repository that owns the row", async () => {
    const session = createSession("targeted-operation");
    const alpha = createSnapshot(`${session.cwd}\\alpha`, "working");
    const beta = createSnapshot(`${session.cwd}\\beta`, "working");
    beta.status.files[0].path = "beta.ts";
    const api = createGitApi({ [session.id]: alpha });
    api.getWorkspaceSnapshot.mockResolvedValue({
      root: session.cwd,
      repositories: [
        { cwd: alpha.cwd, name: "alpha", relativePath: "alpha", snapshot: alpha },
        { cwd: beta.cwd, name: "beta", relativePath: "beta", snapshot: beta }
      ]
    });
    api.getSnapshot.mockImplementation(async (target: GitRepositoryTarget) => target.cwd === beta.cwd ? beta : alpha);
    window.gitApi = api;
    const user = userEvent.setup();

    renderPanel(session);
    const betaRow = (await screen.findByText("beta.ts")).closest(".git-status-row");
    await user.click(betaRow!.querySelector<HTMLButtonElement>(".git-status-inline-action")!);

    await waitFor(() => expect(api.stageFiles).toHaveBeenCalledWith(
      { sessionId: session.id, cwd: beta.cwd },
      ["beta.ts"],
      expect.any(String)
    ));
  });

  it("aggregates conflicts and preserves a repository failure as a retryable card", async () => {
    const session = createSession("partial-failure");
    const alpha = createSnapshot(`${session.cwd}\\alpha`, "conflict");
    const failedCwd = `${session.cwd}\\failed`;
    const summary = vi.fn();
    const api = createGitApi({ [session.id]: alpha });
    api.getWorkspaceSnapshot.mockResolvedValue({
      root: session.cwd,
      repositories: [
        { cwd: alpha.cwd, name: "alpha", relativePath: "alpha", snapshot: alpha },
        { cwd: failedCwd, name: "failed", relativePath: "failed", error: "access denied" }
      ]
    });
    api.getSnapshot.mockResolvedValue(createSnapshot(failedCwd, "clean"));
    window.gitApi = api;
    const user = userEvent.setup();

    render(<I18nProvider locale="zh-CN"><GitStatusPanel session={session} onSummaryChange={summary} /></I18nProvider>);
    expect(await screen.findByText("access denied")).toBeTruthy();
    await waitFor(() => expect(summary).toHaveBeenLastCalledWith({ changes: 1, conflicts: 1 }));
    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.getSnapshot).toHaveBeenCalledWith({ sessionId: session.id, cwd: failedCwd }));
  });

  it("keeps history scoped to the selected discovered repository", async () => {
    const session = createSession("history-panel");
    const alpha = createSnapshot(`${session.cwd}\\alpha`, "working");
    const beta = createSnapshot(`${session.cwd}\\beta`, "clean");
    const api = createGitApi({ [session.id]: alpha });
    api.getWorkspaceSnapshot.mockResolvedValue({
      root: session.cwd,
      repositories: [
        { cwd: alpha.cwd, name: "alpha", relativePath: "alpha", snapshot: alpha },
        { cwd: beta.cwd, name: "beta", relativePath: "beta", snapshot: beta }
      ]
    });
    window.gitApi = api;
    const user = userEvent.setup();

    renderPanel(session);
    await screen.findByText("working.ts");
    await user.click(screen.getByRole("tab", { name: /历史/ }));

    expect(await screen.findByText("Recent change")).toBeTruthy();
    expect(api.getHistory).toHaveBeenCalledWith({ sessionId: session.id, cwd: alpha.cwd }, { skip: 0 });
    await user.click(screen.getByText("Recent change"));
    await waitFor(() => expect(api.getDiff).toHaveBeenCalledWith(
      { sessionId: session.id, cwd: alpha.cwd },
      { scope: "commit", revision: "abcdef123456" }
    ));
  });

  it("enables one-click pull for a branch without upstream when a remote is selected", async () => {
    const session = createSession("first-pull-panel");
    const snapshot = createSnapshot(session.cwd, "working");
    snapshot.status.branch.upstream = undefined;
    const api = createGitApi({ [session.id]: snapshot });
    window.gitApi = api;
    const user = userEvent.setup();

    renderPanel(session);
    await screen.findByText("working.ts");
    const pullButton = screen.getByRole("button", { name: "拉取" });
    await waitFor(() => expect(pullButton.hasAttribute("disabled")).toBe(false));
    await user.click(pullButton);

    await waitFor(() => expect(api.pull).toHaveBeenCalledWith(
      { sessionId: session.id, cwd: snapshot.cwd },
      "origin",
      expect.any(String)
    ));
  });
});
