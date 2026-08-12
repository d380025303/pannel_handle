import { describe, expect, it, vi } from "vitest";
import nativeFileDrag from "./native-file-drag.cjs";

const { resolveNativeDragIcon, startNativeFileDrag } = nativeFileDrag;

function createImage({ empty = false, width = 32, height = 32 } = {}) {
  return {
    isEmpty: vi.fn(() => empty),
    getSize: vi.fn(() => ({ width, height })),
    resize: vi.fn(() => createImage({ width: 32, height: 32 }))
  };
}

describe("native file drag icon", () => {
  it("uses the Windows icon associated with the downloaded file", async () => {
    const fileIcon = createImage();
    const app = { getFileIcon: vi.fn().mockResolvedValue(fileIcon) };
    const nativeImage = { createFromPath: vi.fn() };

    await expect(resolveNativeDragIcon({
      app,
      nativeImage,
      filePath: "C:\\Temp\\report.pdf",
      fallbackIconPath: "C:\\app\\build\\icon.png"
    })).resolves.toBe(fileIcon);

    expect(app.getFileIcon).toHaveBeenCalledWith("C:\\Temp\\report.pdf", { size: "normal" });
    expect(nativeImage.createFromPath).not.toHaveBeenCalled();
  });

  it("constrains an oversized file type icon to 32px", async () => {
    const fileIcon = createImage({ width: 64, height: 32 });
    const resizedIcon = createImage({ width: 32, height: 16 });
    fileIcon.resize.mockReturnValue(resizedIcon);

    await expect(resolveNativeDragIcon({
      app: { getFileIcon: vi.fn().mockResolvedValue(fileIcon) },
      nativeImage: { createFromPath: vi.fn() },
      filePath: "C:\\Temp\\report.pdf",
      fallbackIconPath: "C:\\app\\build\\icon.png"
    })).resolves.toBe(resizedIcon);

    expect(fileIcon.resize).toHaveBeenCalledWith({ width: 32, height: 16, quality: "best" });
  });

  it.each(["empty", "failed"])("uses a 32px app icon when file icon lookup is %s", async (mode) => {
    const fallbackIcon = createImage({ width: 1254, height: 1254 });
    const resizedIcon = createImage();
    fallbackIcon.resize.mockReturnValue(resizedIcon);
    const app = {
      getFileIcon: mode === "empty"
        ? vi.fn().mockResolvedValue(createImage({ empty: true }))
        : vi.fn().mockRejectedValue(new Error("icon lookup failed"))
    };
    const nativeImage = { createFromPath: vi.fn(() => fallbackIcon) };

    await expect(resolveNativeDragIcon({
      app,
      nativeImage,
      filePath: "C:\\Temp\\report.pdf",
      fallbackIconPath: "C:\\app\\build\\icon.png"
    })).resolves.toBe(resizedIcon);

    expect(nativeImage.createFromPath).toHaveBeenCalledWith("C:\\app\\build\\icon.png");
    expect(fallbackIcon.resize).toHaveBeenCalledWith({ width: 32, height: 32, quality: "best" });
  });

  it("passes the small native image and downloaded path to startDrag", async () => {
    const fileIcon = createImage();
    const sender = { startDrag: vi.fn() };

    await startNativeFileDrag({
      app: { getFileIcon: vi.fn().mockResolvedValue(fileIcon) },
      nativeImage: { createFromPath: vi.fn() },
      sender,
      filePath: "C:\\Temp\\report.pdf",
      fallbackIconPath: "C:\\app\\build\\icon.png"
    });

    expect(sender.startDrag).toHaveBeenCalledWith({ file: "C:\\Temp\\report.pdf", icon: fileIcon });
  });
});
