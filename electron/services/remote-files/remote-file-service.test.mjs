import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OFFICE_PREVIEW_LIMIT, TEXT_PREVIEW_LIMIT, createRemoteFileService as createRemoteFileServiceImpl } from "./remote-file-service.cjs";
import { createSshFileSystem } from "../../ssh/ssh-file-system.cjs";
import { createSshSessionRuntime } from "../../ssh/ssh-session-runtime.cjs";

function createTerminalManager(session) {
  return {
    getSession: vi.fn(() => session)
  };
}

function createSessionStore(secret = "plain-secret") {
  return {
    decryptSecret: vi.fn(() => secret)
  };
}

function createRemoteFileService(options) {
  const { sessionStore, knownHostStore, sftpFactory, ...serviceOptions } = options;
  if (!serviceOptions.sshFileSystem && sftpFactory) {
    const sshSessionRuntime = createSshSessionRuntime({
      terminalManager: serviceOptions.terminalManager,
      sessionStore,
      knownHostStore,
      sftpFactory
    });
    serviceOptions.sshFileSystem = createSshFileSystem({ sshSessionRuntime, sftpFactory });
  }
  return createRemoteFileServiceImpl(serviceOptions);
}

function createSftpMock(overrides = {}) {
  return {
    connect: vi.fn(),
    cwd: vi.fn(async () => "/home/deploy"),
    list: vi.fn(async () => []),
    stat: vi.fn(async () => ({ size: 4 })),
    exists: vi.fn(async () => false),
    get: vi.fn(async () => Buffer.from("text")),
    mkdir: vi.fn(),
    put: vi.fn(),
    fastPut: vi.fn(),
    fastGet: vi.fn(),
    end: vi.fn(),
    ...overrides
  };
}

function createShellMock(overrides = {}) {
  return {
    openPath: vi.fn(async () => ""),
    ...overrides
  };
}

function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

describe("remote-file-service", () => {
  it.each(["windows", "wsl"])("bounds large %s listings and yields between batches without changing entries", async (type) => {
    const cwd = type === "windows" ? path.resolve("listing") : "/listing";
    const dirents = Array.from({ length: 30000 }, (_, index) => ({
      name: `entry-${30000 - index}`,
      isDirectory: () => index % 3 === 0,
      isSymbolicLink: () => index % 3 === 1
    }));
    let pending = 0;
    let peak = 0;
    let callsBeforeYield = 0;
    let yielded = false;
    const fsApi = { promises: {
      readdir: async () => {
        setImmediate(() => { yielded = true; });
        return dirents;
      },
      stat: async () => {
        pending += 1;
        peak = Math.max(peak, pending);
        if (!yielded) callsBeforeYield += 1;
        await Promise.resolve();
        pending -= 1;
        return { size: 12, mtimeMs: 34 };
      }
    } };
    const service = createRemoteFileService({
      terminalManager: createTerminalManager({ id: "run-1", type, cwd, wslDistro: "Ubuntu" }), fsApi
    });
    const entries = await service.list("run-1", cwd);
    const expected = dirents.map((dirent) => ({
      name: dirent.name,
      path: type === "windows" ? path.join(cwd, dirent.name) : `${cwd}/${dirent.name}`,
      type: dirent.isDirectory() ? "directory" : dirent.isSymbolicLink() ? "symlink" : "file",
      size: 12, modifiedAt: 34
    })).sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      return a.name.localeCompare(b.name);
    });
    expect(peak).toBe(16);
    expect(callsBeforeYield).toBe(16);
    expect(entries).toEqual(expected);
  });

  it("stops submitting metadata batches when stat fails", async () => {
    const stat = vi.fn(async () => { throw new Error("metadata unavailable"); });
    const service = createRemoteFileService({
      terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: process.cwd() }),
      fsApi: { promises: {
        readdir: async () => Array.from({ length: 100 }, (_, index) => ({ name: String(index) })), stat
      } }
    });
    await expect(service.list("run-1", process.cwd())).rejects.toThrow("metadata unavailable");
    expect(stat).toHaveBeenCalledTimes(16);
  });

  it.each([
    ["~", "\\\\wsl.localhost\\Ubuntu\\home", "/home/alice"],
    ["/var", "\\\\wsl.localhost\\Ubuntu\\var", "/var/alice"],
    ["/mnt/c", "C:\\", "/mnt/c/alice"],
    ["/mnt/d", "D:\\", "/mnt/d/alice"],
    ["/mnt/c/project", "C:\\project", "/mnt/c/project/alice"]
  ])("lists WSL children under %s with matching metadata paths", async (basePath, hostPath, childPath) => {
    const childHostPath = path.win32.join(hostPath, "alice");
    const fsApi = {
      promises: {
        readdir: vi.fn(async (target) => {
          expect(target).toBe(hostPath);
          return [{ name: "alice", isDirectory: () => true, isSymbolicLink: () => false }];
        }),
        stat: vi.fn(async (target) => {
          if (target !== childHostPath) {
            throw Object.assign(new Error(`ENOENT: ${target}`), { code: "ENOENT" });
          }
          return { size: 4096, mtimeMs: 1234 };
        })
      }
    };
    const service = createRemoteFileService({
      terminalManager: createTerminalManager({ id: "run-1", type: "wsl", wslDistro: "Ubuntu", cwd: "~" }),
      fsApi
    });

    await expect(service.list("run-1", basePath)).resolves.toEqual([
      { name: "alice", path: childPath, type: "directory", size: 4096, modifiedAt: 1234 }
    ]);
    expect(fsApi.promises.readdir).toHaveBeenCalledWith(hostPath, { withFileTypes: true });
    expect(fsApi.promises.stat).toHaveBeenCalledExactlyOnceWith(childHostPath);
  });

  it("rejects WSL drive mount traversal before accessing the file system", async () => {
    const fsApi = { promises: { readdir: vi.fn(), stat: vi.fn() } };
    const service = createRemoteFileService({
      terminalManager: createTerminalManager({ id: "run-1", type: "wsl", wslDistro: "Ubuntu", cwd: "~" }),
      fsApi
    });

    await expect(service.list("run-1", "/mnt/c/../d")).rejects.toThrow("Use a canonical absolute Linux path.");
    expect(fsApi.promises.readdir).not.toHaveBeenCalled();
    expect(fsApi.promises.stat).not.toHaveBeenCalled();
  });

  it("preserves UTF-8 BOM and CRLF when saving text", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-format-"));
    const filePath = path.join(dir, "note.txt");
    fs.writeFileSync(filePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\r\ntwo", "utf-8")]));
    try {
      const service = createRemoteFileService({ terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: dir }), sessionStore: createSessionStore(), shellApi: createShellMock() });
      const preview = await service.readText("run-1", filePath);
      expect(preview).toEqual(expect.objectContaining({ content: "one\r\ntwo", bom: true, eol: "crlf" }));
      await service.writeText("run-1", filePath, "next\nline", preview.version, { format: { bom: preview.bom, eol: preview.eol } });
      expect(fs.readFileSync(filePath)).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("next\r\nline")]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates, auto-renames, moves, and trashes Windows entries", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-mutate-"));
    const shellApi = createShellMock({ trashItem: vi.fn(async (target) => fs.promises.rm(target, { recursive: true, force: true })) });
    try {
      const service = createRemoteFileService({ terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: dir }), sessionStore: createSessionStore(), shellApi });
      await expect(service.createEntry("run-1", dir, "note.txt", "file")).resolves.toEqual(expect.objectContaining({ status: "completed" }));
      const renamed = await service.createEntry("run-1", dir, "note.txt", "file", "rename");
      expect(renamed).toEqual(expect.objectContaining({ status: "completed", name: "note (1).txt" }));
      const moved = await service.moveEntry("run-1", renamed.path, dir, "moved.txt");
      expect(moved).toEqual(expect.objectContaining({ status: "completed", name: "moved.txt" }));
      await expect(service.deleteEntry("run-1", moved.path)).resolves.toEqual({ mode: "trash" });
      expect(shellApi.trashItem).toHaveBeenCalledWith(moved.path);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats moving a Windows entry to its unchanged name as completed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-rename-noop-"));
    const filePath = path.join(dir, "note.txt");
    fs.writeFileSync(filePath, "text");
    try {
      const service = createRemoteFileService({ terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: dir }), sessionStore: createSessionStore(), shellApi: createShellMock() });

      await expect(service.moveEntry("run-1", filePath, dir, "note.txt")).resolves.toEqual({
        status: "completed",
        path: filePath,
        name: "note.txt"
      });
      expect(fs.readFileSync(filePath, "utf-8")).toBe("text");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("connects with saved SSH password and lists files", async () => {
    const session = {
      id: "run-1",
      type: "ssh",
      sshConfig: {
        host: "example.com",
        username: "deploy",
        port: 2222,
        encryptedSecret: "ciphertext",
        extraArgs: []
      }
    };
    const sftp = createSftpMock({
      list: vi.fn(async () => [
        { name: "app.log", type: "-", size: 10, modifyTime: 1000 },
        { name: "var", type: "d", size: 0, modifyTime: 900 }
      ])
    });
    const service = createRemoteFileService({
      terminalManager: createTerminalManager(session),
      sessionStore: createSessionStore(),
      sftpFactory: () => sftp
    });

    await expect(service.list("run-1", "/home/deploy")).resolves.toEqual([
      expect.objectContaining({ name: "var", path: "/home/deploy/var", type: "directory" }),
      expect.objectContaining({ name: "app.log", path: "/home/deploy/app.log", type: "file" })
    ]);
    expect(sftp.connect).toHaveBeenCalledWith(expect.objectContaining({
      host: "example.com",
      username: "deploy",
      port: 2222,
      password: "plain-secret"
    }));
  });

  it("rejects missing sessions", async () => {
    const service = createRemoteFileService({
      terminalManager: createTerminalManager(undefined),
      sessionStore: createSessionStore(),
      sftpFactory: () => createSftpMock()
    });

    await expect(service.list("run-1", ".")).rejects.toThrow("Session is not running.");
  });

  it("lists Windows files with directories first", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-files-"));
    const childDir = path.join(dir, "src");
    const childFile = path.join(dir, "readme.txt");
    fs.mkdirSync(childDir);
    fs.writeFileSync(childFile, "hello", "utf-8");
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: dir }),
        sessionStore: createSessionStore(),
        sftpFactory: () => createSftpMock()
      });

      await expect(service.getHome("run-1")).resolves.toBe(dir);
      await expect(service.list("run-1", dir)).resolves.toEqual([
        expect.objectContaining({ name: "src", path: childDir, type: "directory" }),
        expect.objectContaining({ name: "readme.txt", path: childFile, type: "file", size: 5 })
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows Windows file operations outside the session working directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-outside-"));
    const workingDirectory = path.join(root, "workspace");
    const outsideDirectory = path.join(root, "shared");
    const outsideFile = path.join(outsideDirectory, "note.txt");
    fs.mkdirSync(workingDirectory);
    fs.mkdirSync(outsideDirectory);
    fs.writeFileSync(outsideFile, "before", "utf-8");
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: workingDirectory }),
        sessionStore: createSessionStore(),
        shellApi: createShellMock()
      });

      await expect(service.list("run-1", outsideDirectory)).resolves.toEqual([
        expect.objectContaining({ name: "note.txt", path: outsideFile })
      ]);
      const preview = await service.readText("run-1", outsideFile);
      await expect(service.writeText("run-1", outsideFile, "after", preview.version)).resolves.toEqual(
        expect.objectContaining({ status: "saved" })
      );
      expect(fs.readFileSync(outsideFile, "utf-8")).toBe("after");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows SSH listing outside the configured session working directory", async () => {
    const sftp = createSftpMock();
    const service = createRemoteFileService({
      terminalManager: createTerminalManager({
        id: "run-1",
        type: "ssh",
        cwd: "/srv/app",
        sshConfig: { host: "example.com", username: "deploy", port: 22, extraArgs: [] }
      }),
      sessionStore: createSessionStore(),
      sftpFactory: () => sftp
    });

    await expect(service.list("run-1", "/etc")).resolves.toEqual([]);
    expect(sftp.list).toHaveBeenCalledWith("/etc");
  });

  it("previews and writes Windows text files with conflict detection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-files-"));
    const filePath = path.join(dir, "note.txt");
    fs.writeFileSync(filePath, "text", "utf-8");
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: dir }),
        sessionStore: createSessionStore(),
        sftpFactory: () => createSftpMock()
      });

      const preview = await service.readText("run-1", filePath);
      expect(preview).toEqual({
        kind: "text",
        size: 4,
        content: "text",
        encoding: "utf-8",
        bom: false,
        eol: "lf",
        version: "982d9e3eb996f559e633f4d194def3761d909f5a3b647d1a851fead67c32c9d1"
      });

      await expect(service.writeText("run-1", filePath, "updated", preview.version)).resolves.toEqual({
        status: "saved",
        size: 7,
        version: "27eb5e51506c911f6fc4bb345c0d9db6f60415fceab7c18e1e9b862637415777"
      });
      expect(fs.readFileSync(filePath, "utf-8")).toBe("updated");

      await expect(service.writeText("run-1", filePath, "again", preview.version)).resolves.toEqual({
        status: "conflict"
      });
      expect(fs.readFileSync(filePath, "utf-8")).toBe("updated");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates Windows image preview urls and streams media ranges", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-files-"));
    const filePath = path.join(dir, "image.png");
    const content = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    fs.writeFileSync(filePath, content);
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: dir }),
        sessionStore: createSessionStore(),
        sftpFactory: () => createSftpMock()
      });

      const preview = await service.previewFile("run-1", filePath);
      expect(preview).toEqual(expect.objectContaining({
        kind: "image",
        size: content.length,
        mime: "image/png",
        previewId: expect.any(String),
        url: expect.stringMatching(/^pannel-media:\/\/preview\//)
      }));

      const fullResponse = service.createPreviewStreamResponse(preview.previewId);
      expect(fullResponse.statusCode).toBe(200);
      expect(fullResponse.headers).toEqual(expect.objectContaining({
        "Content-Type": "image/png",
        "Content-Length": String(content.length),
        "Accept-Ranges": "bytes"
      }));
      await expect(readStream(fullResponse.data)).resolves.toEqual(content);

      const rangeResponse = service.createPreviewStreamResponse(preview.url, "bytes=2-5");
      expect(rangeResponse.statusCode).toBe(206);
      expect(rangeResponse.headers).toEqual(expect.objectContaining({
        "Content-Range": "bytes 2-5/10",
        "Content-Length": "4"
      }));
      await expect(readStream(rangeResponse.data)).resolves.toEqual(Buffer.from([2, 3, 4, 5]));

      expect(service.releasePreview(preview.previewId)).toBe(true);
      expect(() => service.createPreviewStreamResponse(preview.previewId)).toThrow("Preview is not available.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates read-only Office previews for Windows files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-office-"));
    const filePath = path.join(dir, "report.docx");
    fs.writeFileSync(filePath, Buffer.from("fake-docx"));
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: dir }),
        sessionStore: createSessionStore(),
        sftpFactory: () => createSftpMock()
      });

      const preview = await service.previewFile("run-1", filePath);
      expect(preview).toEqual(expect.objectContaining({
        kind: "office",
        format: "word",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 9,
        previewId: expect.any(String)
      }));
      const response = service.createPreviewStreamResponse(preview.previewId);
      expect(response.headers).toEqual(expect.objectContaining({
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      }));
      await expect(readStream(response.data)).resolves.toEqual(Buffer.from("fake-docx"));
      expect(service.releasePreview(preview.previewId)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("downloads SSH Office previews to the managed cache and deletes them on release", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-office-cache-"));
    const sftp = createSftpMock({
      stat: vi.fn(async () => ({ size: 12 })),
      fastGet: vi.fn(async (_remotePath, localPath) => fs.promises.writeFile(localPath, "fake-sheet"))
    });
    const service = createRemoteFileService({
      terminalManager: createTerminalManager({ id: "run-1", type: "ssh", sshConfig: { host: "example.com", extraArgs: [] } }),
      sessionStore: createSessionStore(),
      sftpFactory: () => sftp,
      previewCacheRoot: cacheRoot
    });
    try {
      const preview = await service.previewFile("run-1", "/tmp/report.xlsx");
      expect(preview).toEqual(expect.objectContaining({ kind: "office", format: "spreadsheet", size: 12 }));
      expect(sftp.fastGet).toHaveBeenCalledWith("/tmp/report.xlsx", expect.stringMatching(/\.xlsx$/));
      const cachedFiles = fs.readdirSync(cacheRoot);
      expect(cachedFiles).toHaveLength(1);

      expect(service.releasePreview(preview.previewId)).toBe(true);
      await vi.waitFor(() => expect(fs.existsSync(path.join(cacheRoot, cachedFiles[0]))).toBe(false));
    } finally {
      await service.shutdown();
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("rejects oversized Office previews before reading file contents", async () => {
    const stat = vi.fn(async () => ({ size: OFFICE_PREVIEW_LIMIT + 1, isFile: () => true }));
    const service = createRemoteFileService({
      terminalManager: createTerminalManager({ id: "run-1", type: "wsl", cwd: "/home/me", wslDistro: "Ubuntu" }),
      sessionStore: createSessionStore(),
      fsApi: { promises: { stat } }
    });

    await expect(service.previewFile("run-1", "/home/me/report.pptx")).resolves.toEqual({
      kind: "too_large",
      size: OFFICE_PREVIEW_LIMIT + 1,
      limit: OFFICE_PREVIEW_LIMIT
    });
  });

  it("maps WSL Linux paths to the distro UNC path", async () => {
    const readdir = vi.fn(async () => [
      { name: "app.js", isDirectory: () => false, isSymbolicLink: () => false }
    ]);
    const stat = vi.fn(async () => ({ size: 8, mtimeMs: 1234 }));
    const service = createRemoteFileService({
      terminalManager: createTerminalManager({ id: "run-1", type: "wsl", cwd: "/home/me/project", wslDistro: "Ubuntu-24.04" }),
      sessionStore: createSessionStore(),
      sftpFactory: () => createSftpMock(),
      fsApi: {
        promises: {
          readdir,
          stat
        }
      }
    });

    await expect(service.getHome("run-1")).resolves.toBe("/home/me/project");
    await expect(service.list("run-1", "/home/me/project")).resolves.toEqual([
      expect.objectContaining({ name: "app.js", path: "/home/me/project/app.js", type: "file", size: 8 })
    ]);
    expect(readdir).toHaveBeenCalledWith("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\project", { withFileTypes: true });
    expect(stat).toHaveBeenCalledWith("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\project\\app.js");
  });

  it("creates WSL video previews through the distro UNC path", async () => {
    const stat = vi.fn(async () => ({ size: 128, isFile: () => true }));
    const service = createRemoteFileService({
      terminalManager: createTerminalManager({ id: "run-1", type: "wsl", cwd: "/home/me/project", wslDistro: "Ubuntu-24.04" }),
      sessionStore: createSessionStore(),
      sftpFactory: () => createSftpMock(),
      fsApi: {
        promises: {
          stat
        }
      }
    });

    const preview = await service.previewFile("run-1", "/home/me/project/clip.mp4");
    expect(preview).toEqual(expect.objectContaining({
      kind: "video",
      size: 128,
      mime: "video/mp4",
      previewId: expect.any(String),
      url: expect.stringMatching(/^pannel-media:\/\/preview\//)
    }));
    expect(stat).toHaveBeenCalledWith("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\project\\clip.mp4");
    expect(service.releasePreview(preview.previewId)).toBe(true);
  });

  it("opens the current Windows directory in Explorer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-files-"));
    const shellApi = createShellMock();
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: dir }),
        sessionStore: createSessionStore(),
        sftpFactory: () => createSftpMock(),
        shellApi
      });

      await expect(service.openInExplorer("run-1", ".")).resolves.toBeUndefined();
      expect(shellApi.openPath).toHaveBeenCalledWith(path.resolve(dir, "."));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens the current WSL directory through the distro UNC path", async () => {
    const shellApi = createShellMock();
    const service = createRemoteFileService({
      terminalManager: createTerminalManager({ id: "run-1", type: "wsl", cwd: "/home/me/project", wslDistro: "Ubuntu-24.04" }),
      sessionStore: createSessionStore(),
      sftpFactory: () => createSftpMock(),
      shellApi
    });

    await expect(service.openInExplorer("run-1", "/home/me/project")).resolves.toBeUndefined();
    expect(shellApi.openPath).toHaveBeenCalledWith("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\project");
  });

  it("does not open Explorer for SSH sessions", async () => {
    const shellApi = createShellMock();
    const service = createRemoteFileService({
      terminalManager: createTerminalManager({ id: "run-1", type: "ssh", sshConfig: { host: "example.com", extraArgs: [] } }),
      sessionStore: createSessionStore(),
      sftpFactory: () => createSftpMock(),
      shellApi
    });

    await expect(service.openInExplorer("run-1", "/home/deploy")).rejects.toThrow("local files");
    expect(shellApi.openPath).not.toHaveBeenCalled();
  });

  it("rejects when Explorer cannot open the path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-files-"));
    const shellApi = createShellMock({
      openPath: vi.fn(async () => "Cannot open path")
    });
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: dir }),
        sessionStore: createSessionStore(),
        sftpFactory: () => createSftpMock(),
        shellApi
      });

      await expect(service.openInExplorer("run-1", dir)).rejects.toThrow("Cannot open path");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns preview states for text, binary, and oversized files", async () => {
    const session = {
      id: "run-1",
      type: "ssh",
      sshConfig: { host: "example.com", extraArgs: [] }
    };
    const sftp = createSftpMock();
    const service = createRemoteFileService({
      terminalManager: createTerminalManager(session),
      sessionStore: createSessionStore(),
      sftpFactory: () => sftp
    });

    await expect(service.readText("run-1", "/tmp/a.txt")).resolves.toEqual({
      kind: "text",
      size: 4,
      content: "text",
      encoding: "utf-8",
      bom: false,
      eol: "lf",
      version: "982d9e3eb996f559e633f4d194def3761d909f5a3b647d1a851fead67c32c9d1"
    });

    sftp.stat.mockResolvedValueOnce({ size: 3 });
    sftp.get.mockResolvedValueOnce(Buffer.from([0, 1, 2]));
    await expect(service.readText("run-1", "/tmp/bin")).resolves.toEqual({
      kind: "binary",
      size: 3
    });

    sftp.stat.mockResolvedValueOnce({ size: TEXT_PREVIEW_LIMIT + 1 });
    await expect(service.readText("run-1", "/tmp/large.log")).resolves.toEqual({
      kind: "too_large",
      size: TEXT_PREVIEW_LIMIT + 1,
      limit: TEXT_PREVIEW_LIMIT
    });
  });

  it("does not create local media previews for SSH files", async () => {
    const session = {
      id: "run-1",
      type: "ssh",
      sshConfig: { host: "example.com", extraArgs: [] }
    };
    const sftp = createSftpMock({
      stat: vi.fn(async () => ({ size: 3 })),
      get: vi.fn(async () => Buffer.from([0, 1, 2]))
    });
    const service = createRemoteFileService({
      terminalManager: createTerminalManager(session),
      sessionStore: createSessionStore(),
      sftpFactory: () => sftp
    });

    await expect(service.previewFile("run-1", "/tmp/image.png")).resolves.toEqual({
      kind: "binary",
      size: 3
    });
  });

  it("writes text when the expected content version still matches", async () => {
    const session = {
      id: "run-1",
      type: "ssh",
      sshConfig: { host: "example.com", extraArgs: [] }
    };
    const sftp = createSftpMock();
    const service = createRemoteFileService({
      terminalManager: createTerminalManager(session),
      sessionStore: createSessionStore(),
      sftpFactory: () => sftp
    });

    await expect(service.writeText(
      "run-1",
      "/tmp/a.txt",
      "updated",
      "982d9e3eb996f559e633f4d194def3761d909f5a3b647d1a851fead67c32c9d1"
    )).resolves.toEqual({
      status: "saved",
      size: 7,
      version: "27eb5e51506c911f6fc4bb345c0d9db6f60415fceab7c18e1e9b862637415777"
    });
    expect(sftp.put).toHaveBeenCalledWith(Buffer.from("updated"), "/tmp/a.txt");
  });

  it("writes Windows binary files and creates parent directories", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-files-"));
    const imagePath = path.join(dir, ".pannel-handle-images", "image.png");
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: dir }),
        sessionStore: createSessionStore(),
        sftpFactory: () => createSftpMock()
      });

      await expect(service.writeBinaryFile("run-1", imagePath, Buffer.from([1, 2, 3]))).resolves.toEqual({
        remotePath: imagePath
      });
      expect(fs.readFileSync(imagePath)).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes SSH binary files after ensuring the remote directory exists", async () => {
    const session = {
      id: "run-1",
      type: "ssh",
      sshConfig: { host: "example.com", extraArgs: [] }
    };
    const sftp = createSftpMock();
    const service = createRemoteFileService({
      terminalManager: createTerminalManager(session),
      sessionStore: createSessionStore(),
      sftpFactory: () => sftp
    });

    await expect(service.writeBinaryFile(
      "run-1",
      "/home/deploy/.pannel-handle-images/image.png",
      Buffer.from([4, 5, 6])
    )).resolves.toEqual({
      remotePath: "/home/deploy/.pannel-handle-images/image.png"
    });
    expect(sftp.mkdir).toHaveBeenCalledWith("/home/deploy/.pannel-handle-images", true);
    expect(sftp.put).toHaveBeenCalledWith(Buffer.from([4, 5, 6]), "/home/deploy/.pannel-handle-images/image.png");
  });

  it("uploads multiple Windows files to the target directory", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-upload-src-"));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-upload-dst-"));
    const firstFile = path.join(sourceDir, "first.txt");
    const secondFile = path.join(sourceDir, "second.txt");
    fs.writeFileSync(firstFile, "one", "utf-8");
    fs.writeFileSync(secondFile, "two", "utf-8");
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: targetDir }),
        sessionStore: createSessionStore(),
        sftpFactory: () => createSftpMock()
      });

      await expect(service.uploadFiles("run-1", [firstFile, secondFile], targetDir)).resolves.toEqual([
        { status: "completed", remotePath: path.join(targetDir, "first.txt") },
        { status: "completed", remotePath: path.join(targetDir, "second.txt") }
      ]);
      expect(fs.readFileSync(path.join(targetDir, "first.txt"), "utf-8")).toBe("one");
      expect(fs.readFileSync(path.join(targetDir, "second.txt"), "utf-8")).toBe("two");
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("reports intermediate progress while uploading a Windows file", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-upload-progress-src-"));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-upload-progress-dst-"));
    const sourceFile = path.join(sourceDir, "large.dump");
    const content = Buffer.alloc(2 * 1024 * 1024, 7);
    fs.writeFileSync(sourceFile, content);
    const progress = [];
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: targetDir }),
        sessionStore: createSessionStore(),
        sftpFactory: () => createSftpMock()
      });

      await expect(service.uploadFile("run-1", sourceFile, targetDir, "cancel", {
        onProgress: (event) => progress.push(event)
      })).resolves.toEqual({ status: "completed", remotePath: path.join(targetDir, "large.dump") });

      expect(progress[0]).toEqual({ transferredBytes: 0, totalBytes: content.length, percent: 0 });
      expect(progress.some((event) => event.transferredBytes > 0 && event.transferredBytes < content.length)).toBe(true);
      expect(progress.at(-1)).toEqual({ transferredBytes: content.length, totalBytes: content.length, percent: 100 });
      expect(Buffer.compare(fs.readFileSync(path.join(targetDir, "large.dump")), content)).toBe(0);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("reports intermediate progress while uploading through a WSL path", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-wsl-upload-progress-src-"));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-wsl-upload-progress-dst-"));
    const sourceFile = path.join(sourceDir, "large.dump");
    const targetFile = path.join(targetDir, "large.dump");
    const content = Buffer.alloc(128 * 1024, 3);
    fs.writeFileSync(sourceFile, content);
    const progress = [];
    try {
      const missingTarget = Object.assign(new Error("missing"), { code: "ENOENT" });
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({
          id: "run-1",
          type: "wsl",
          cwd: "/home/me/project",
          wslDistro: "Ubuntu-24.04"
        }),
        sessionStore: createSessionStore(),
        sftpFactory: () => createSftpMock(),
        fsApi: {
          promises: {
            stat: () => fs.promises.stat(sourceFile),
            lstat: vi.fn(async () => { throw missingTarget; })
          },
          createReadStream: () => fs.createReadStream(sourceFile),
          createWriteStream: () => fs.createWriteStream(targetFile)
        }
      });

      await expect(service.uploadFile("run-1", sourceFile, "/home/me/project", "cancel", {
        onProgress: (event) => progress.push(event)
      })).resolves.toEqual({ status: "completed", remotePath: "/home/me/project/large.dump" });

      expect(progress.some((event) => event.transferredBytes > 0 && event.transferredBytes < content.length)).toBe(true);
      expect(progress.at(-1)).toEqual({ transferredBytes: content.length, totalBytes: content.length, percent: 100 });
      expect(Buffer.compare(fs.readFileSync(targetFile), content)).toBe(0);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("rejects directory uploads before copying any Windows files", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-upload-src-"));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-upload-dst-"));
    const firstFile = path.join(sourceDir, "first.txt");
    const childDir = path.join(sourceDir, "folder");
    fs.writeFileSync(firstFile, "one", "utf-8");
    fs.mkdirSync(childDir);
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: targetDir }),
        sessionStore: createSessionStore(),
        sftpFactory: () => createSftpMock()
      });

      await expect(service.uploadFiles("run-1", [firstFile, childDir], targetDir)).rejects.toThrow("Directory upload");
      expect(fs.existsSync(path.join(targetDir, "first.txt"))).toBe(false);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("does not report upload progress while waiting for conflict resolution", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-upload-conflict-src-"));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-upload-conflict-dst-"));
    const sourceFile = path.join(sourceDir, "same.txt");
    fs.writeFileSync(sourceFile, "source", "utf-8");
    fs.writeFileSync(path.join(targetDir, "same.txt"), "target", "utf-8");
    const onProgress = vi.fn();
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: targetDir }),
        sessionStore: createSessionStore(),
        sftpFactory: () => createSftpMock()
      });

      await expect(service.uploadFile("run-1", sourceFile, targetDir, "cancel", { onProgress })).resolves.toEqual({
        status: "conflict",
        remotePath: path.join(targetDir, "same.txt")
      });
      expect(onProgress).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("uploads multiple SSH files with remote target paths", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-upload-src-"));
    const firstFile = path.join(sourceDir, "first.txt");
    const secondFile = path.join(sourceDir, "second.txt");
    fs.writeFileSync(firstFile, "one", "utf-8");
    fs.writeFileSync(secondFile, "two", "utf-8");
    try {
      const session = {
        id: "run-1",
        type: "ssh",
        sshConfig: { host: "example.com", extraArgs: [] }
      };
      const sftp = createSftpMock();
      const service = createRemoteFileService({
        terminalManager: createTerminalManager(session),
        sessionStore: createSessionStore(),
        sftpFactory: () => sftp
      });

      await expect(service.uploadFiles("run-1", [firstFile, secondFile], "/home/deploy")).resolves.toEqual([
        { status: "completed", remotePath: "/home/deploy/first.txt" },
        { status: "completed", remotePath: "/home/deploy/second.txt" }
      ]);
      expect(sftp.fastPut).toHaveBeenCalledWith(firstFile, "/home/deploy/first.txt");
      expect(sftp.fastPut).toHaveBeenCalledWith(secondFile, "/home/deploy/second.txt");
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it("reports SSH upload progress from fastPut", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-ssh-upload-progress-"));
    const sourceFile = path.join(sourceDir, "remote.bin");
    fs.writeFileSync(sourceFile, Buffer.alloc(10));
    const progress = [];
    try {
      const session = {
        id: "run-1",
        type: "ssh",
        sshConfig: { host: "example.com", extraArgs: [] }
      };
      const sftp = createSftpMock({
        fastPut: vi.fn(async (_localPath, _remotePath, options) => {
          options.step(6, 6, 10);
        })
      });
      const service = createRemoteFileService({
        terminalManager: createTerminalManager(session),
        sessionStore: createSessionStore(),
        sftpFactory: () => sftp
      });

      await service.uploadFile("run-1", sourceFile, "/home/deploy", "cancel", {
        onProgress: (event) => progress.push(event)
      });

      expect(sftp.fastPut).toHaveBeenCalledWith(sourceFile, "/home/deploy/remote.bin", expect.objectContaining({ step: expect.any(Function) }));
      expect(progress).toEqual([
        { transferredBytes: 0, totalBytes: 10, percent: 0 },
        { transferredBytes: 6, totalBytes: 10, percent: 60 },
        { transferredBytes: 10, totalBytes: 10, percent: 100 }
      ]);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it("downloads a Windows file to a specified local path", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-download-src-"));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-download-dst-"));
    const sourceFile = path.join(sourceDir, "note.txt");
    const targetFile = path.join(targetDir, "note-copy.txt");
    fs.writeFileSync(sourceFile, "downloaded", "utf-8");
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: sourceDir }),
        sessionStore: createSessionStore(),
        sftpFactory: () => createSftpMock()
      });

      await expect(service.downloadFile("run-1", sourceFile, targetFile, { transferId: "download-1" })).resolves.toEqual({
        localPath: targetFile,
        transferId: "download-1"
      });
      expect(fs.readFileSync(targetFile, "utf-8")).toBe("downloaded");
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("reports local download progress and removes a canceled partial file", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-download-src-"));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-download-dst-"));
    const sourceFile = path.join(sourceDir, "large.bin");
    const targetFile = path.join(targetDir, "large-copy.bin");
    fs.writeFileSync(sourceFile, Buffer.alloc(256 * 1024, 1));
    const progress = [];
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: sourceDir }),
        sessionStore: createSessionStore(),
        sftpFactory: () => createSftpMock()
      });
      const download = service.downloadFile("run-1", sourceFile, targetFile, {
        transferId: "cancel-me",
        onProgress: (event) => {
          progress.push(event);
          if (event.transferredBytes === 0) void service.cancelDownload("cancel-me");
        }
      });

      await expect(download).rejects.toMatchObject({ code: "DOWNLOAD_CANCELED" });
      expect(progress[0]).toMatchObject({ transferId: "cancel-me", transferredBytes: 0, totalBytes: 256 * 1024 });
      expect(fs.existsSync(targetFile)).toBe(false);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("reports SSH fastGet progress using a dedicated client", async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-download-dst-"));
    const targetFile = path.join(targetDir, "remote.bin");
    const progress = [];
    const sftp = createSftpMock({
      stat: vi.fn(async () => ({ size: 10 })),
      fastGet: vi.fn(async (_remotePath, _localPath, options) => options.step(6, 6, 10))
    });
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({
          id: "run-1",
          type: "ssh",
          sshConfig: { host: "example.com", username: "deploy", encryptedSecret: "ciphertext", extraArgs: [] }
        }),
        sessionStore: createSessionStore(),
        sftpFactory: () => sftp
      });

      await service.downloadFile("run-1", "/tmp/remote.bin", targetFile, {
        transferId: "ssh-download",
        onProgress: (event) => progress.push(event)
      });

      expect(sftp.fastGet).toHaveBeenCalledWith("/tmp/remote.bin", targetFile, expect.objectContaining({ step: expect.any(Function) }));
      expect(progress).toEqual(expect.arrayContaining([
        expect.objectContaining({ transferredBytes: 0, totalBytes: 10, percent: 0 }),
        expect.objectContaining({ transferredBytes: 6, totalBytes: 10, percent: 60 }),
        expect.objectContaining({ transferredBytes: 10, totalBytes: 10, percent: 100 })
      ]));
      expect(sftp.end).toHaveBeenCalled();
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("rejects a conflicting remote change without writing", async () => {
    const session = {
      id: "run-1",
      type: "ssh",
      sshConfig: { host: "example.com", extraArgs: [] }
    };
    const sftp = createSftpMock();
    const service = createRemoteFileService({
      terminalManager: createTerminalManager(session),
      sessionStore: createSessionStore(),
      sftpFactory: () => sftp
    });

    await expect(service.writeText("run-1", "/tmp/a.txt", "updated", "stale")).resolves.toEqual({
      status: "conflict"
    });
    expect(sftp.put).not.toHaveBeenCalled();
  });

  it.each([false, true])("checks the saved version after recovering an idle SSH connection (changed=%s)", async changed => {
    const first = createSftpMock();
    const next = createSftpMock({ get: vi.fn(async () => Buffer.from(changed ? "remote edit" : "text")) });
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValue(next);
    const service = createRemoteFileService({
      terminalManager: createTerminalManager({ id: "run-1", type: "ssh", sshConfig: { host: "example.com", extraArgs: [] } }),
      sessionStore: createSessionStore(),
      sftpFactory: factory
    });
    const preview = await service.readText("run-1", "/tmp/a.txt");
    first.stat.mockRejectedValue(new Error("stat: stat: No SFTP connection available"));
    const result = await service.writeText("run-1", "/tmp/a.txt", "updated", preview.version);
    expect(result.status).toBe(changed ? "conflict" : "saved");
    expect(factory).toHaveBeenCalledTimes(2);
    expect(next.put).toHaveBeenCalledTimes(changed ? 0 : 1);
    await service.shutdown();
  });

  it("rejects edited text over the preview limit", async () => {
    const session = {
      id: "run-1",
      type: "ssh",
      sshConfig: { host: "example.com", extraArgs: [] }
    };
    const sftp = createSftpMock();
    const service = createRemoteFileService({
      terminalManager: createTerminalManager(session),
      sessionStore: createSessionStore(),
      sftpFactory: () => sftp
    });

    await expect(service.writeText("run-1", "/tmp/a.txt", "x".repeat(TEXT_PREVIEW_LIMIT + 1), "version"))
      .rejects.toThrow("edit limit");
    expect(sftp.get).not.toHaveBeenCalled();
    expect(sftp.put).not.toHaveBeenCalled();
  });
});
