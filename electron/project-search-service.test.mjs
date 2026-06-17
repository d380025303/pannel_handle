import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProjectSearchService, MAX_TEXT_FILE_SIZE } from "./project-search-service.cjs";

function createTerminalManager(session) {
  return {
    getSession: vi.fn(() => session)
  };
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
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

  it("searches text with line numbers and skips binary and oversized files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-search-"));
    try {
      writeFile(path.join(dir, "src", "app.ts"), "alpha\nneedle here\nomega");
      writeFile(path.join(dir, "src", "binary.bin"), Buffer.from([0, 1, 2, 3]));
      writeFile(path.join(dir, "src", "large.txt"), Buffer.alloc(MAX_TEXT_FILE_SIZE + 1, "n"));

      const service = createProjectSearchService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: dir })
      });

      const result = await service.searchText("run-1", "needle");
      expect(result.root).toBe(dir);
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

  it("rejects SSH sessions", async () => {
    const service = createProjectSearchService({
      terminalManager: createTerminalManager({ id: "run-1", type: "ssh", sshConfig: { host: "example.com" } })
    });

    await expect(service.searchFiles("run-1", "app")).rejects.toThrow("Windows and WSL");
    await expect(service.searchText("run-1", "app")).rejects.toThrow("Windows and WSL");
  });
});
