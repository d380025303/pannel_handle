// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { GitDiffResult, GitRepositorySnapshot, GitRepositoryTarget, GitWorkspaceSnapshot, TerminalSession } from "../../vite-env";
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
    getWorkspaceSnapshot: vi.fn(async (sessionId: string): Promise<GitWorkspaceSnapshot> => ({
      root: snapshotBySession[sessionId].cwd,
      repositories: [{ cwd: snapshotBySession[sessionId].cwd, name: sessionId, relativePath: ".", snapshot: snapshotBySession[sessionId] }]
    })),
    getSnapshot: vi.fn(async (target: GitRepositoryTarget) => snapshotBySession[target.sessionId]),
    getStatus: vi.fn(async (target: GitRepositoryTarget) => snapshotBySession[target.sessionId].status),
    getDiff: vi.fn(async (_target: { sessionId: string; cwd: string }, request: { scope: string }) => ({
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
