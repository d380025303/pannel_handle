import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createProjectSearchService,
  createRipgrepInvocation,
  MAX_TEXT_FILE_SIZE,
  parseRipgrepMatch
} from "./project-search-service.cjs";

function createTerminalManager(session) {
  return {
    getSession: vi.fn(() => session)
  };
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createChildProcess({ stdout = "", stderr = "", code = 0, autoClose = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let closed = false;
  const close = (exitCode) => {
    if (closed) return;
    closed = true;
    child.emit("close", exitCode);
  };
  child.kill = vi.fn(() => {
    queueMicrotask(() => close(null));
    return true;
  });
  child.start = () => {
    if (!autoClose) return;
    queueMicrotask(() => {
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      close(code);
    });
  };
  return child;
}

function createMatchEvent(relativePath, line, query, lineNumber = 1) {
  const start = Buffer.byteLength(line.slice(0, line.indexOf(query)), "utf-8");
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: relativePath },
      lines: { text: `${line}\n` },
      line_number: lineNumber,
      submatches: [{ match: { text: query }, start, end: start + Buffer.byteLength(query, "utf-8") }]
    }
  });
}

describe("project-search-service", () => {
  it("searches Windows files recursively and skips default excluded directories", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-search-"));
    try {
      writeFile(path.join(dir, "src", "ProjectSearchModal.tsx"), "component");
      writeFile(path.join(dir, "node_modules", "pkg", "ProjectSearchModal.tsx"), "ignored");

      const service = createProjectSearchService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: dir })
      });

      await expect(service.searchFiles("run-1", "searchmodal")).resolves.toEqual({
        root: dir,
        results: [
          {
            path: path.join(dir, "src", "ProjectSearchModal.tsx"),
            relativePath: path.join("src", "ProjectSearchModal.tsx"),
            name: "ProjectSearchModal.tsx"
          }
        ]
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues file-name searches beyond the text-search traversal limit", async () => {
    const entries = Array.from({ length: 30000 }, (_, index) => ({
      name: `unrelated-${index}.txt`,
      isDirectory: () => false,
      isFile: () => true
    }));
    entries.push({
      name: "CustomerDataController.java",
      isDirectory: () => false,
      isFile: () => true
    });

    const service = createProjectSearchService({
      terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: "C:\\workspace" }),
      fsApi: {
        promises: {
          readdir: vi.fn(async () => entries)
        }
      }
    });

    await expect(service.searchFiles("run-1", "CustomerDataController")).resolves.toEqual({
      root: "C:\\workspace",
      results: [
        {
          path: "C:\\workspace\\CustomerDataController.java",
          relativePath: "CustomerDataController.java",
          name: "CustomerDataController.java"
        }
      ]
    });
  });

  it("searches text with line numbers and skips binary and oversized files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-search-"));
    try {
      writeFile(path.join(dir, "src", "app.ts"), "alpha\nneedle here\nomega");
      writeFile(path.join(dir, "src", "binary.bin"), Buffer.from([0, 1, 2, 3]));
      writeFile(path.join(dir, "src", "large.txt"), Buffer.alloc(MAX_TEXT_FILE_SIZE + 1, "n"));

      const service = createProjectSearchService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: dir }),
        forceTextFallback: true
      });

      const result = await service.searchText("run-1", "needle", "request-1");
      expect(result.root).toBe(dir);
      expect(result.engine).toBe("fallback");
      expect(result.results).toEqual([
        expect.objectContaining({
          path: path.join(dir, "src", "app.ts"),
          relativePath: path.join("src", "app.ts"),
          name: "app.ts",
          lineNumber: 2,
          line: "needle here",
          matchStart: 0,
          matchLength: 6
        })
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps WSL search roots through the distro UNC path and returns Linux paths", async () => {
    const readdir = vi.fn(async () => [
      { name: "src", isDirectory: () => true, isFile: () => false },
      { name: "dist", isDirectory: () => true, isFile: () => false }
    ]);
    readdir.mockResolvedValueOnce([
      { name: "src", isDirectory: () => true, isFile: () => false },
      { name: "dist", isDirectory: () => true, isFile: () => false }
    ]);
    readdir.mockResolvedValueOnce([
      { name: "main.rs", isDirectory: () => false, isFile: () => true }
    ]);

    const service = createProjectSearchService({
      terminalManager: createTerminalManager({
        id: "run-1",
        type: "wsl",
        cwd: "/home/me/project",
        wslDistro: "Ubuntu-24.04"
      }),
      fsApi: {
        promises: {
          readdir
        }
      }
    });

    await expect(service.searchFiles("run-1", "main")).resolves.toEqual({
      root: "/home/me/project",
      results: [
        {
          path: "/home/me/project/src/main.rs",
          relativePath: "src/main.rs",
          name: "main.rs"
        }
      ]
    });
    expect(readdir).toHaveBeenNthCalledWith(1, "\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\project", { withFileTypes: true });
    expect(readdir).toHaveBeenNthCalledWith(2, "\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\project\\src", { withFileTypes: true });
  });

  it("builds native Windows and WSL ripgrep invocations with ignore-aware literal search", async () => {
    const windowsInvocation = await createRipgrepInvocation(
      { type: "windows", cwd: "C:\\workspace" },
      "Needle",
      async () => "C:\\app\\rg.exe"
    );
    expect(windowsInvocation).toEqual(expect.objectContaining({
      command: "C:\\app\\rg.exe",
      cwd: "C:\\workspace"
    }));
    expect(windowsInvocation.args).toEqual(expect.arrayContaining([
      "--json",
      "--fixed-strings",
      "--ignore-case",
      "--hidden",
      "--max-filesize",
      String(MAX_TEXT_FILE_SIZE),
      "!target/**"
    ]));
    expect(windowsInvocation.args).not.toContain("--no-ignore");

    const wslInvocation = await createRipgrepInvocation({
      type: "wsl",
      cwd: "/home/me/project",
      wslDistro: "Ubuntu-24.04"
    }, "Needle");
    expect(wslInvocation.command).toBe("wsl.exe");
    expect(wslInvocation.args.slice(0, 7)).toEqual([
      "-d",
      "Ubuntu-24.04",
      "--cd",
      "/home/me/project",
      "--exec",
      "rg",
      "--json"
    ]);
  });

  it("converts ripgrep UTF-8 byte offsets to renderer string offsets", () => {
    const event = JSON.parse(createMatchEvent("src/中文.ts", "前缀中文needle后缀", "needle", 8));
    const result = parseRipgrepMatch(event, { type: "wsl" }, "/home/me/project");
    expect(result).toEqual(expect.objectContaining({
      path: "/home/me/project/src/中文.ts",
      relativePath: "src/中文.ts",
      lineNumber: 8,
      line: "前缀中文needle后缀",
      matchStart: 4,
      matchLength: 6
    }));
  });

  it("streams ripgrep JSON and stops after the global result limit", async () => {
    const output = Array.from({ length: 301 }, (_, index) => (
      createMatchEvent(`src/file-${index}.ts`, `needle ${index}`, "needle", index + 1)
    )).join("\n");
    const child = createChildProcess({ stdout: output });
    const spawnProcess = vi.fn(() => {
      child.start();
      return child;
    });
    const service = createProjectSearchService({
      terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: "C:\\workspace" }),
      spawnProcess,
      resolveRipgrepPath: async () => "C:\\app\\rg.exe"
    });

    const result = await service.searchText("run-1", "needle", "request-1");
    expect(result.engine).toBe("ripgrep");
    expect(result.results).toHaveLength(300);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("falls back in WSL when rg is unavailable and enumerates non-ignored Git files", async () => {
    const rgChild = createChildProcess({ stderr: "execvpe(rg) failed: No such file or directory", code: 127 });
    const gitChild = createChildProcess({ stdout: "src/app.ts\0" });
    const spawnProcess = vi.fn()
      .mockImplementationOnce(() => {
        rgChild.start();
        return rgChild;
      })
      .mockImplementationOnce(() => {
        gitChild.start();
        return gitChild;
      });
    const service = createProjectSearchService({
      terminalManager: createTerminalManager({
        id: "run-1",
        type: "wsl",
        cwd: "/home/me/project",
        wslDistro: "Ubuntu-24.04"
      }),
      spawnProcess,
      fsApi: {
        promises: {
          stat: vi.fn(async () => ({ size: 20 })),
          readFile: vi.fn(async () => Buffer.from("needle here", "utf-8"))
        }
      }
    });

    const result = await service.searchText("run-1", "needle", "request-1");
    expect(result.engine).toBe("fallback");
    expect(result.results).toEqual([
      expect.objectContaining({ path: "/home/me/project/src/app.ts", lineNumber: 1 })
    ]);
    expect(spawnProcess.mock.calls[1][1]).toEqual(expect.arrayContaining([
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z"
    ]));
  });

  it("cancels the active ripgrep process for the matching request", async () => {
    const child = createChildProcess({ autoClose: false });
    const service = createProjectSearchService({
      terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: "C:\\workspace" }),
      spawnProcess: vi.fn(() => child),
      resolveRipgrepPath: async () => "C:\\app\\rg.exe"
    });
    const search = service.searchText("run-1", "needle", "request-1");
    await vi.waitFor(() => expect(child.listenerCount("close")).toBeGreaterThan(0));

    expect(service.cancelTextSearch("run-1", "other-request")).toBe(false);
    expect(service.cancelTextSearch("run-1", "request-1")).toBe(true);
    await expect(search).rejects.toMatchObject({ code: "SEARCH_CANCELLED" });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("rejects SSH sessions", async () => {
    const service = createProjectSearchService({
      terminalManager: createTerminalManager({ id: "run-1", type: "ssh", sshConfig: { host: "example.com" } })
    });

    await expect(service.searchFiles("run-1", "app")).rejects.toThrow("Windows and WSL");
    await expect(service.searchText("run-1", "app", "request-1")).rejects.toThrow("Windows and WSL");
  });
});
