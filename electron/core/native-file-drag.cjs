const DRAG_ICON_SIZE = 32;

function isUsableNativeImage(image) {
  return Boolean(image && typeof image.isEmpty === "function" && !image.isEmpty());
}

function fitDragIcon(image) {
  const size = typeof image.getSize === "function" ? image.getSize() : null;
  if (!size || (size.width <= DRAG_ICON_SIZE && size.height <= DRAG_ICON_SIZE)) {
    return image;
  }
  const scale = DRAG_ICON_SIZE / Math.max(size.width, size.height);
  return image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: "best"
  });
}

async function resolveNativeDragIcon({ app, nativeImage, filePath, fallbackIconPath }) {
  try {
    const fileIcon = await app.getFileIcon(filePath, { size: "normal" });
    if (isUsableNativeImage(fileIcon)) {
      return fitDragIcon(fileIcon);
    }
  } catch {
    // Fall back to the bundled app icon when Windows cannot resolve a file icon.
  }

  const fallbackIcon = nativeImage.createFromPath(fallbackIconPath);
  if (!isUsableNativeImage(fallbackIcon)) {
    throw new Error("Cannot create a native file drag icon.");
  }
  return fallbackIcon.resize({ width: DRAG_ICON_SIZE, height: DRAG_ICON_SIZE, quality: "best" });
}

async function startNativeFileDrag({ app, nativeImage, sender, filePath, fallbackIconPath }) {
  const icon = await resolveNativeDragIcon({ app, nativeImage, filePath, fallbackIconPath });
  sender.startDrag({ file: filePath, icon });
}

module.exports = {
  resolveNativeDragIcon,
  startNativeFileDrag
};
