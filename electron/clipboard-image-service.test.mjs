import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { createClipboardImageService, createImageFileName } from "./clipboard-image-service.cjs";

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
});
