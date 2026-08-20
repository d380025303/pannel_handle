import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { GIT_IPC_CHANNELS, registerGitIpcHandlers } = require("./git-ipc-handlers.cjs");

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel) => handlers.delete(channel))
  };
}

function createGitService() {
  return new Proxy({}, {
    get(target, property) {
      if (!target[property]) target[property] = vi.fn(() => "result");
      return target[property];
    }
  });
}

const target = { sessionId: "session-1", cwd: "C:\\work\\repo" };
const operationId = "operation-1";
const branch = { kind: "local", name: "main" };
const file = { path: "src/App.tsx", status: "M" };
const message = { subject: "Subject", body: "Body" };
const options = { skip: 30 };

const routes = [
  ["git:status", "getStatus", { target }, [target]],
  ["git:snapshot", "getSnapshot", { target }, [target]],
  ["git:workspace-snapshot", "getWorkspaceSnapshot", { sessionId: "session-1" }, ["session-1"]],
  ["git:diff", "getDiff", { target, request: file }, [target, file]],
  ["git:branches", "getBranches", { target }, [target]],
  ["git:remotes", "getRemotes", { target }, [target]],
  ["git:checkout-branch", "checkoutBranch", { target, branch, operationId }, [target, branch, operationId]],
  ["git:create-branch", "createBranch", { target, branchName: "feature/test", operationId }, [target, "feature/test", operationId]],
  ["git:stashes", "getStashes", { target }, [target]],
  ["git:history", "getHistory", { target, options }, [target, options]],
  ["git:stage-files", "stageFiles", { target, paths: ["src/App.tsx"], operationId }, [target, ["src/App.tsx"], operationId]],
  ["git:stage-all", "stageAll", { target, operationId }, [target, operationId]],
  ["git:unstage-files", "unstageFiles", { target, paths: ["src/App.tsx"], operationId }, [target, ["src/App.tsx"], operationId]],
  ["git:unstage-all", "unstageAll", { target, operationId }, [target, operationId]],
  ["git:discard-working-tree", "discardWorkingTree", { target, file, operationId }, [target, file, operationId]],
  ["git:commit", "commit", { target, message, operationId }, [target, message, operationId]],
  ["git:fetch", "fetchRemote", { target, remote: "origin", operationId }, [target, "origin", operationId]],
  ["git:pull", "pullBranch", { target, operationId }, [target, operationId]],
  ["git:push", "pushBranch", { target, remote: "origin", operationId }, [target, "origin", operationId]],
  ["git:stash-changes", "stashChanges", { target, message: "WIP", operationId }, [target, "WIP", operationId]],
  ["git:apply-stash", "applyStash", { target, ref: "stash@{0}", operationId }, [target, "stash@{0}", operationId]],
  ["git:pop-stash", "popStash", { target, ref: "stash@{0}", operationId }, [target, "stash@{0}", operationId]],
  ["git:drop-stash", "dropStash", { target, ref: "stash@{0}", operationId }, [target, "stash@{0}", operationId]],
  ["git:revert-file", "revertFile", { target, file, operationId }, [target, file, operationId]],
  ["git:cancel-operation", "cancelOperation", { operationId }, [operationId]]
];

describe("Git IPC handlers", () => {
  it("registers and routes every Git channel", () => {
    const ipcMain = createIpcMain();
    const gitService = createGitService();
    registerGitIpcHandlers({ ipcMain, gitService });

    expect(Array.from(ipcMain.handlers.keys())).toEqual(GIT_IPC_CHANNELS);
    expect(routes.map(([channel]) => channel)).toEqual(GIT_IPC_CHANNELS);

    for (const [channel, method, payload, args] of routes) {
      expect(ipcMain.handlers.get(channel)({}, payload)).toBe("result");
      expect(gitService[method]).toHaveBeenCalledWith(...args);
    }
  });

  it("keeps the legacy diff file payload fallback", () => {
    const ipcMain = createIpcMain();
    const gitService = createGitService();
    registerGitIpcHandlers({ ipcMain, gitService });

    ipcMain.handlers.get("git:diff")({}, { target, file });

    expect(gitService.getDiff).toHaveBeenCalledWith(target, file);
  });

  it("removes every registered handler", () => {
    const ipcMain = createIpcMain();
    const unregister = registerGitIpcHandlers({ ipcMain, gitService: createGitService() });

    unregister();

    expect(ipcMain.handlers.size).toBe(0);
    expect(ipcMain.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(GIT_IPC_CHANNELS);
  });
});
