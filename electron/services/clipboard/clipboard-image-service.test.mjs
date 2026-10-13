import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClipboardImageService, createImageFileName, resolveSessionWorkingDirectory } from "./clipboard-image-service.cjs";
import { createRemoteFileService } from "../remote-files/remote-file-service.cjs";

function createNativeImageMock(buffer) {
  return {
    isEmpty: vi.fn(() => !buffer),
    toPNG: vi.fn(() => buffer)
  };
}

describe("clipboard-image-service", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["x.svg", 1, "不支持的图片格式"],
    ["x", 1, "不支持的图片格式"],
    ["x.png", 0, "图片文件为空"],
    ["x.png", 10 * 1024 * 1024 + 1, "10 MiB"]
  ])("rejects invalid uploads before reading %s (%s bytes)", async (name, size, error) => {
    vi.spyOn(fs.promises, "stat").mockResolvedValue({ size });
    const readFile = vi.spyOn(fs.promises, "readFile").mockResolvedValue(Buffer.from([1]));
    const writeBinaryFile = vi.fn();
    const writeFile = vi.spyOn(fs.promises, "writeFile").mockResolvedValue();
    const service = createClipboardImageService({
      clipboard: { readImage: vi.fn() },
      terminalManager: { getSession: () => ({ type: "ssh", cwd: "/work" }) },
      remoteFileService: { writeBinaryFile }
    });
    await expect(service.uploadImageToSession("run-1", name)).rejects.toThrow(error);
    expect(readFile).not.toHaveBeenCalled();
    expect(writeBinaryFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it.each([0, 10 * 1024 * 1024 + 1])("revalidates %s bytes after upload reading", async size => {
    vi.spyOn(fs.promises, "stat").mockResolvedValue({ size: 1 });
    vi.spyOn(fs.promises, "readFile").mockResolvedValue(Buffer.alloc(size));
    const writeBinaryFile = vi.fn();
    const service = createClipboardImageService({
      clipboard: { readImage: vi.fn() },
      terminalManager: { getSession: () => ({ type: "ssh", cwd: "/work" }) },
      remoteFileService: { writeBinaryFile }
    });
    await expect(service.uploadImageToSession("run-1", "x.png")).rejects.toThrow(size ? "10 MiB" : "图片文件为空");
    expect(writeBinaryFile).not.toHaveBeenCalled();
  });

  it.each(["paste", "upload", "clipboard"])("accepts the exact 10 MiB limit through %s", async entry => {
    const bytes = Buffer.alloc(10 * 1024 * 1024);
    vi.spyOn(fs.promises, "stat").mockResolvedValue({ size: bytes.length });
    vi.spyOn(fs.promises, "readFile").mockResolvedValue(bytes);
    const writeBinaryFile = vi.fn(async (_id, remotePath) => ({ remotePath }));
    const service = createClipboardImageService({
      clipboard: { readImage: () => createNativeImageMock(bytes) },
      terminalManager: { getSession: () => ({ type: "ssh", cwd: "/work" }) },
      remoteFileService: { writeBinaryFile }
    });
    const result = await (entry === "paste"
      ? service.pasteImageToSession("run-1", { image: { name: "x.WEBP", bytes } })
      : entry === "clipboard"
        ? service.pasteImageToSession("run-1")
        : service.uploadImageToSession("run-1", "x.WEBP"));
    expect(result).toEqual({ status: "saved", path: expect.stringMatching(entry === "clipboard" ? /^\/work\/\.pannel-handle-images\/.*\.png$/ : /^\/work\/\.pannel-handle-images\/.*\.webp$/), size: bytes.length });
    expect(writeBinaryFile).toHaveBeenCalledOnce();
    const [sessionId, savedPath, savedBytes] = writeBinaryFile.mock.calls[0];
    expect([sessionId, savedPath]).toEqual(["run-1", result.path]);
    expect(Buffer.isBuffer(savedBytes)).toBe(true);
    expect(savedBytes.equals(bytes)).toBe(true);
    if (entry === "clipboard") expect(savedBytes).toBe(bytes);
  });

  it.each([undefined, "C:\\work"])("rejects oversized clipboard images before storage (localCwd: %s)", async localCwd => {
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 1);
    const mkdir = vi.spyOn(fs.promises, "mkdir").mockResolvedValue();
    const writeFile = vi.spyOn(fs.promises, "writeFile").mockResolvedValue();
    const writeBinaryFile = vi.fn();
    const service = createClipboardImageService({
      clipboard: { readImage: () => createNativeImageMock(bytes) },
      terminalManager: { getSession: () => ({ type: "ssh", cwd: "/work" }) },
      remoteFileService: { writeBinaryFile }
    });
    await expect(service.pasteImageToSession("run-1", { localCwd })).rejects.toThrow("图片文件不能超过 10 MiB。");
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(writeBinaryFile).not.toHaveBeenCalled();
  });

  it("builds deterministic PNG file names", () => {
    const fileName = createImageFileName(
      new Date(2026, 5, 17, 15, 30, 0),
      () => Buffer.from([0xa1, 0xb2, 0xc3])
    );

    expect(fileName).toBe("image-20260617-153000-a1b2c3.png");
  });

  it.each([undefined, Buffer.alloc(0)])("returns no_image when the clipboard image is empty (%s)", async buffer => {
    const remoteFileService = {
      getHome: vi.fn(),
      writeBinaryFile: vi.fn()
    };
    const service = createClipboardImageService({
      clipboard: { readImage: vi.fn(() => createNativeImageMock(buffer)) },
      terminalManager: { getSession: vi.fn() },
      remoteFileService
    });

    await expect(service.pasteImageToSession("run-1")).resolves.toEqual({ status: "no_image" });
    expect(remoteFileService.getHome).not.toHaveBeenCalled();
    expect(remoteFileService.writeBinaryFile).not.toHaveBeenCalled();
  });

  it.each(["windows", "wsl", "ssh"])("saves copied JPEG bytes for %s without reading the system image", async type => {
    const clipboard = { readImage: vi.fn() };
    const writeBinaryFile = vi.fn(async (_id, remotePath) => ({ remotePath }));
    const service = createClipboardImageService({ clipboard,
      terminalManager: { getSession: () => ({ type, cwd: type === "windows" ? "C:\\work" : "/work" }) },
      remoteFileService: { getHome: async () => "C:\\work", writeBinaryFile } });
    const result = await service.pasteImageToSession("run-1", { image: { name: "original.JPG", bytes: new Uint8Array([1, 2, 3]) } });
    expect(result.path).toMatch(/\.jpg$/);
    expect(result.path).toContain(".pannel-handle-images");
    expect(writeBinaryFile).toHaveBeenCalledWith("run-1", result.path, Buffer.from([1, 2, 3]));
    expect(clipboard.readImage).not.toHaveBeenCalled();
  });

  it.each([
    [{ name: "x.svg", bytes: new Uint8Array([1]) }, "不支持的图片格式"],
    [{ name: "x.png", bytes: new Uint8Array() }, "图片文件为空"],
    [{ name: "x.png", bytes: new Uint8Array(10 * 1024 * 1024 + 1) }, "10 MiB"],
    [{ name: "x.png", bytes: [1] }, "无效的图片文件"]
  ])("rejects invalid copied image payloads", async (image, error) => {
    const writeBinaryFile = vi.fn();
    const writeFile = vi.spyOn(fs.promises, "writeFile").mockResolvedValue();
    const service = createClipboardImageService({ clipboard: { readImage: vi.fn() },
      terminalManager: { getSession: vi.fn() }, remoteFileService: { writeBinaryFile } });
    await expect(service.pasteImageToSession("run-1", { image, localCwd: "C:\\work" })).rejects.toThrow(error);
    expect(writeBinaryFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("saves a Windows clipboard image under the session image directory", async () => {
    const pngBuffer = Buffer.from([1, 2, 3]);
    const session = { id: "run-1", type: "windows" };
    const remoteFileService = {
      getHome: vi.fn(async () => "C:\\work"),
      writeBinaryFile: vi.fn(async (_sessionId, remotePath) => ({ remotePath }))
    };
    const service = createClipboardImageService({
      clipboard: { readImage: vi.fn(() => createNativeImageMock(pngBuffer)) },
      terminalManager: { getSession: vi.fn(() => session) },
      remoteFileService,
      now: () => new Date(2026, 5, 17, 15, 30, 0),
      randomBytes: () => Buffer.from([0xa1, 0xb2, 0xc3])
    });

    const expectedPath = path.win32.join("C:\\work", ".pannel-handle-images", "image-20260617-153000-a1b2c3.png");
    await expect(service.pasteImageToSession("run-1")).resolves.toEqual({
      status: "saved",
      path: expectedPath,
      size: 3
    });
    expect(remoteFileService.writeBinaryFile).toHaveBeenCalledWith("run-1", expectedPath, pngBuffer);
  });

  it("saves a remote clipboard image with a POSIX path", async () => {
    const pngBuffer = Buffer.from([4, 5, 6]);
    const session = { id: "run-1", type: "ssh" };
    const remoteFileService = {
      getHome: vi.fn(async () => "/home/deploy"),
      writeBinaryFile: vi.fn(async (_sessionId, remotePath) => ({ remotePath }))
    };
    const service = createClipboardImageService({
      clipboard: { readImage: vi.fn(() => createNativeImageMock(pngBuffer)) },
      terminalManager: { getSession: vi.fn(() => session) },
      remoteFileService,
      now: () => new Date(2026, 5, 17, 15, 30, 0),
      randomBytes: () => Buffer.from([0xa1, 0xb2, 0xc3])
    });

    await expect(service.pasteImageToSession("run-1")).resolves.toEqual({
      status: "saved",
      path: "/home/deploy/.pannel-handle-images/image-20260617-153000-a1b2c3.png",
      size: 3
    });
  });

  it.skipIf(process.platform !== "win32")("saves local bridge App Server images in its local workspace", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-local-app-server-image-"));
    const pngBuffer = Buffer.from([1, 2, 3]);
    const remoteFileService = { writeBinaryFile: vi.fn() };
    const service = createClipboardImageService({
      clipboard: { readImage: () => createNativeImageMock(pngBuffer) },
      terminalManager: { getSession: () => ({ id: "bridge", type: "ssh", agentLocation: "local" }) },
      remoteFileService
    });
    try {
      const result = await service.pasteImageToSession("bridge", { localCwd: directory });
      expect(result.status).toBe("saved");
      expect(fs.readFileSync(result.path)).toEqual(pngBuffer);
      expect(remoteFileService.writeBinaryFile).not.toHaveBeenCalled();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("saves images under the configured Windows working directory", async () => {
    const pngBuffer = Buffer.from([7, 8, 9]);
    const remoteFileService = {
      getHome: vi.fn(async () => "C:\\work space"),
      writeBinaryFile: vi.fn(async (_sessionId, remotePath) => ({ remotePath }))
    };
    const service = createClipboardImageService({
      clipboard: { readImage: vi.fn(() => createNativeImageMock(pngBuffer)) },
      terminalManager: { getSession: vi.fn(() => ({ id: "run-1", type: "windows", cwd: "C:\\work space" })) },
      remoteFileService,
      now: () => new Date(2026, 5, 17, 15, 30, 0),
      randomBytes: () => Buffer.from([0xa1, 0xb2, 0xc3])
    });

    const result = await service.pasteImageToSession("run-1");
    expect(result).toEqual(expect.objectContaining({
      status: "saved",
      path: "C:\\work space\\.pannel-handle-images\\image-20260617-153000-a1b2c3.png"
    }));
    expect(remoteFileService.getHome).toHaveBeenCalledWith("run-1");
  });

  it.skipIf(process.platform !== "win32").each(
    ["relative", "absolute", "empty"].flatMap(cwd => ["clipboard", "paste", "upload"].map(entry => [cwd, entry]))
  )("uses the real file service working directory for %s cwd through %s", async (cwdKind, entry) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-image-cwd-"));
    const bytes = Buffer.from([1, 2, 3]);
    try {
      vi.spyOn(os, "homedir").mockReturnValue(directory);
      const cwd = cwdKind === "relative" ? "project"
        : cwdKind === "absolute" ? path.join(directory, "absolute project") : "";
      const terminalManager = { getSession: () => ({ id: "run-1", type: "windows", cwd }) };
      const remoteFileService = createRemoteFileService({ terminalManager });
      const service = createClipboardImageService({
        clipboard: { readImage: () => createNativeImageMock(bytes) },
        terminalManager,
        remoteFileService
      });
      const home = await remoteFileService.getHome("run-1");
      expect(home).toBe(cwdKind === "empty" ? directory : path.join(directory, cwdKind === "relative" ? "project" : "absolute project"));
      const sourcePath = path.join(directory, "source.png");
      fs.writeFileSync(sourcePath, bytes);
      const result = await (entry === "upload" ? service.uploadImageToSession("run-1", sourcePath)
        : entry === "paste" ? service.pasteImageToSession("run-1", { image: { name: "source.png", bytes } })
          : service.pasteImageToSession("run-1"));
      expect(result.status).toBe("saved");
      expect(path.dirname(result.path)).toBe(path.join(home, ".pannel-handle-images"));
      expect(fs.readFileSync(result.path)).toEqual(bytes);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves WSL and SSH tilde working directories from the session home", async () => {
    const remoteFileService = { getHome: vi.fn(async () => "/home/me") };
    await expect(resolveSessionWorkingDirectory(
      { type: "wsl", cwd: "~/project space" },
      remoteFileService,
      "wsl-1"
    )).resolves.toBe("/home/me/project space");
    await expect(resolveSessionWorkingDirectory(
      { type: "ssh", cwd: "~" },
      remoteFileService,
      "ssh-1"
    )).resolves.toBe("/home/me");
  });

  it("propagates image upload failures", async () => {
    const service = createClipboardImageService({
      clipboard: { readImage: vi.fn(() => createNativeImageMock(Buffer.from([1]))) },
      terminalManager: { getSession: vi.fn(() => ({ id: "run-1", type: "ssh", cwd: "/srv/app" })) },
      remoteFileService: {
        getHome: vi.fn(),
        writeBinaryFile: vi.fn(async () => { throw new Error("remote disk full"); })
      }
    });
    await expect(service.pasteImageToSession("run-1")).rejects.toThrow("remote disk full");
  });

  it("uploads a local image file preserving its extension", async () => {
    const payload = Buffer.from([10, 20, 30, 40]);
    const tempFile = path.join(os.tmpdir(), `clipboard-image-test-${Date.now()}.jpg`);
    fs.writeFileSync(tempFile, payload);

    const remoteFileService = {
      getHome: vi.fn(async () => "/home/deploy"),
      writeBinaryFile: vi.fn(async (_sessionId, remotePath) => ({ remotePath }))
    };
    const service = createClipboardImageService({
      clipboard: { readImage: vi.fn() },
      terminalManager: { getSession: vi.fn(() => ({ id: "run-1", type: "ssh" })) },
      remoteFileService,
      now: () => new Date(2026, 5, 17, 15, 30, 0),
      randomBytes: () => Buffer.from([0xa1, 0xb2, 0xc3])
    });

    const expectedPath = "/home/deploy/.pannel-handle-images/image-20260617-153000-a1b2c3.jpg";
    await expect(service.uploadImageToSession("run-1", tempFile)).resolves.toEqual({
      status: "saved",
      path: expectedPath,
      size: 4
    });
    expect(remoteFileService.writeBinaryFile).toHaveBeenCalledWith("run-1", expectedPath, payload);

    fs.unlinkSync(tempFile);
  });

  it("rejects when the local image file cannot be read", async () => {
    const service = createClipboardImageService({
      clipboard: { readImage: vi.fn() },
      terminalManager: { getSession: vi.fn(() => ({ id: "run-1", type: "ssh", cwd: "/srv/app" })) },
      remoteFileService: { getHome: vi.fn(), writeBinaryFile: vi.fn() }
    });
    await expect(service.uploadImageToSession("run-1", "/no/such/file.png")).rejects.toThrow(/无法读取图片文件/);
  });
});
