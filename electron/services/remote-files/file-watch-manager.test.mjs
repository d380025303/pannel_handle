import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import fileWatchManagerModule from "./file-watch-manager.cjs";

const { createFileWatchManager } = fileWatchManagerModule;

class FakeWatcher extends EventEmitter {
  close = vi.fn(async () => undefined);
  add = vi.fn();
  unwatch = vi.fn(async () => undefined);
}

function createHarness(session) {
  const watchers = [];
  const watch = vi.fn(() => {
    const watcher = new FakeWatcher();
    watchers.push(watcher);
    return watcher;
  });
  const broadcast = vi.fn();
  const terminalManager = {
    getSession: vi.fn(() => session)
  };
  const manager = createFileWatchManager({
    terminalManager,
    broadcast,
    chokidarLoader: vi.fn(async () => ({ watch }))
  });
  return { broadcast, manager, terminalManager, watch, watchers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("file watch manager", () => {
  it("uses polling for WSL directories hosted through wsl.localhost", async () => {
    const harness = createHarness({ id: "run-1", type: "wsl", wslDistro: "Ubuntu" });

    await expect(harness.manager.setDirectories("run-1", ["/home/me/project", "/home/me/project"])).resolves.toBe(true);

    expect(harness.watch).toHaveBeenCalledWith(
      ["\\\\wsl.localhost\\Ubuntu\\home\\me\\project"],
      {
        persistent: true,
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 180, pollInterval: 50 },
        usePolling: true,
        interval: 250,
        binaryInterval: 500
      }
    );
    await harness.manager.shutdown();
  });

  it.each([
    {
      name: "Windows directories",
      session: { id: "run-1", type: "windows" },
      displayPath: "C:\\workspace",
      hostPath: "C:\\workspace"
    },
    {
      name: "Windows-mounted directories in WSL",
      session: { id: "run-1", type: "wsl", wslDistro: "Ubuntu" },
      displayPath: "/mnt/c/workspace",
      hostPath: "C:\\workspace"
    }
  ])("keeps native watching for $name", async ({ session, displayPath, hostPath }) => {
    const harness = createHarness(session);

    await harness.manager.setDirectories("run-1", [displayPath]);

    expect(harness.watch).toHaveBeenCalledWith(
      [hostPath],
      expect.not.objectContaining({ usePolling: true })
    );
    await harness.manager.shutdown();
  });

  it("debounces file events and maps them back to the displayed directory", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ id: "run-1", type: "wsl", wslDistro: "Ubuntu" });
    await harness.manager.setDirectories("run-1", ["/home/me/project"]);

    harness.watchers[0].emit("all", "change", "\\\\wsl.localhost\\Ubuntu\\home\\me\\project\\src\\app.ts");
    harness.watchers[0].emit("all", "change", "\\\\wsl.localhost\\Ubuntu\\home\\me\\project\\README.md");
    await vi.advanceTimersByTimeAsync(179);
    expect(harness.broadcast).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.broadcast).toHaveBeenCalledOnce();
    expect(harness.broadcast).toHaveBeenCalledWith("remote-files:changed", {
      sessionId: "run-1",
      paths: ["/home/me/project"]
    });
    await harness.manager.shutdown();
  });

  it("updates watched directories without replacing the watcher", async () => {
    const harness = createHarness({ id: "run-1", type: "windows" });
    await harness.manager.setDirectories("run-1", ["C:\\workspace"]);
    const firstWatcher = harness.watchers[0];

    firstWatcher.emit("error", new Error("watch failed"));
    expect(harness.broadcast).toHaveBeenCalledWith("remote-files:watch-error", {
      sessionId: "run-1",
      error: "watch failed"
    });

    await harness.manager.setDirectories("run-1", ["C:\\workspace", "C:\\workspace\\src"]);
    expect(firstWatcher.add).toHaveBeenCalledWith(["C:\\workspace\\src"]);
    expect(firstWatcher.close).not.toHaveBeenCalled();
    expect(harness.watch).toHaveBeenCalledOnce();

    vi.useFakeTimers();
    firstWatcher.emit("all", "change", "C:\\workspace\\src\\App.tsx");
    await vi.advanceTimersByTimeAsync(180);
    expect(harness.broadcast).toHaveBeenCalledWith("remote-files:changed", {
      sessionId: "run-1",
      paths: ["C:\\workspace\\src"]
    });

    await harness.manager.setDirectories("run-1", ["C:\\workspace"]);
    expect(firstWatcher.unwatch).toHaveBeenCalledWith(["C:\\workspace\\src"]);
    expect(firstWatcher.close).not.toHaveBeenCalled();

    await harness.manager.shutdown();
    expect(firstWatcher.close).toHaveBeenCalledOnce();
  });

  it("serializes rapid watch updates and stop", async () => {
    const harness = createHarness({ id: "run-1", type: "windows" });
    const first = harness.manager.setDirectories("run-1", ["C:\\workspace"]);
    const second = harness.manager.setDirectories("run-1", ["C:\\workspace", "C:\\workspace\\src"]);
    const stopped = harness.manager.stop("run-1");
    await Promise.all([first, second, stopped]);
    expect(harness.watch).toHaveBeenCalledOnce();
    expect(harness.watchers[0].add).toHaveBeenCalledWith(["C:\\workspace\\src"]);
    expect(harness.watchers[0].close).toHaveBeenCalledOnce();
  });

  it("does not create watchers for unavailable, SSH, or empty sessions", async () => {
    const missing = createHarness(undefined);
    await expect(missing.manager.setDirectories("missing", ["C:\\workspace"])).resolves.toBe(false);
    expect(missing.watch).not.toHaveBeenCalled();

    const ssh = createHarness({ id: "run-1", type: "ssh" });
    await expect(ssh.manager.setDirectories("run-1", ["/srv/project"])).resolves.toBe(false);
    expect(ssh.watch).not.toHaveBeenCalled();

    const windows = createHarness({ id: "run-1", type: "windows" });
    await expect(windows.manager.setDirectories("run-1", ["", "   "])).resolves.toBe(true);
    expect(windows.watch).not.toHaveBeenCalled();
  });
});
