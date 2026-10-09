import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClipboardImageService, createImageFileName, resolveSessionWorkingDirectory } from "./clipboard-image-service.cjs";

function createNativeImageMock(buffer) {
  return {
    isEmpty: vi.fn(() => !buffer),
    toPNG: vi.fn(() => buffer)
  };
}

describe("clipboard-image-service", () => {
  it("builds deterministic PNG file names", () => {
    const fileName = createImageFileName(
      new Date(2026, 5, 17, 15, 30, 0),
      () => Buffer.from([0xa1, 0xb2, 0xc3])
    );

    expect(fileName).toBe("image-20260617-153000-a1b2c3.png");
  });

  it("returns no_image when the clipboard has no image", async () => {
    const remoteFileService = {
      getHome: vi.fn(),
      writeBinaryFile: vi.fn()
    };
    const service = createClipboardImageService({
      clipboard: { readImage: vi.fn(() => createNativeImageMock(undefined)) },
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
      remoteFileService: { writeBinaryFile } });
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
    const service = createClipboardImageService({ clipboard: { readImage: vi.fn() },
      terminalManager: { getSession: vi.fn() }, remoteFileService: { writeBinaryFile } });
    await expect(service.pasteImageToSession("run-1", { image })).rejects.toThrow(error);
    expect(writeBinaryFile).not.toHaveBeenCalled();
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
      getHome: vi.fn(async () => "C:\\Users\\me"),
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
    expect(remoteFileService.getHome).not.toHaveBeenCalled();
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
