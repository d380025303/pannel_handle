const crypto = require("node:crypto");
const path = require("node:path");

const IMAGE_DIR_NAME = ".pannel-handle-images";

function pad(value) {
  return String(value).padStart(2, "0");
}

function createImageFileName(now = new Date(), randomBytes = crypto.randomBytes) {
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("");
  return `image-${stamp}-${randomBytes(3).toString("hex")}.png`;
}

function joinSessionPath(session, basePath, fileName) {
  if (session.type === "windows") {
    return path.win32.join(basePath, IMAGE_DIR_NAME, fileName);
  }
  return path.posix.join(basePath.replace(/\\/g, "/"), IMAGE_DIR_NAME, fileName);
}

function getPngBuffer(image) {
  if (!image || typeof image.isEmpty !== "function" || image.isEmpty()) {
    return undefined;
  }
  if (typeof image.toPNG !== "function") {
    throw new Error("Clipboard image cannot be converted to PNG.");
  }
  const buffer = image.toPNG();
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return undefined;
  }
  return buffer;
}

function createClipboardImageService({
  clipboard,
  terminalManager,
  remoteFileService,
  now = () => new Date(),
  randomBytes = crypto.randomBytes
}) {
  async function pasteImageToSession(sessionId) {
    const image = clipboard.readImage();
    const pngBuffer = getPngBuffer(image);
    if (!pngBuffer) {
      return { status: "no_image" };
    }

    const session = terminalManager.getSession(sessionId);
    if (!session) {
      throw new Error("Session is not running.");
    }

    const basePath = await remoteFileService.getHome(sessionId);
    const fileName = createImageFileName(now(), randomBytes);
    const remotePath = joinSessionPath(session, basePath, fileName);
    const saved = await remoteFileService.writeBinaryFile(sessionId, remotePath, pngBuffer);
    return {
      status: "saved",
      path: saved.remotePath,
      size: pngBuffer.length
    };
  }

  return {
    pasteImageToSession
  };
}

module.exports = {
  IMAGE_DIR_NAME,
  createClipboardImageService,
  createImageFileName
};
