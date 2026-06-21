import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TEXT_PREVIEW_LIMIT, createRemoteFileService } from "./remote-file-service.cjs";

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

function createSftpMock(overrides = {}) {
  return {
    connect: vi.fn(),
    cwd: vi.fn(async () => "/home/deploy"),
    list: vi.fn(async () => []),
    stat: vi.fn(async () => ({ size: 4 })),
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
        { remotePath: path.join(targetDir, "first.txt") },
        { remotePath: path.join(targetDir, "second.txt") }
      ]);
      expect(fs.readFileSync(path.join(targetDir, "first.txt"), "utf-8")).toBe("one");
      expect(fs.readFileSync(path.join(targetDir, "second.txt"), "utf-8")).toBe("two");
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
        { remotePath: "/home/deploy/first.txt" },
        { remotePath: "/home/deploy/second.txt" }
      ]);
      expect(sftp.fastPut).toHaveBeenCalledWith(firstFile, "/home/deploy/first.txt");
      expect(sftp.fastPut).toHaveBeenCalledWith(secondFile, "/home/deploy/second.txt");
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

      await expect(service.downloadFile("run-1", sourceFile, targetFile)).resolves.toEqual({ localPath: targetFile });
      expect(fs.readFileSync(targetFile, "utf-8")).toBe("downloaded");
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
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
