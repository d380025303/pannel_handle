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

async function resolveSessionWorkingDirectory(session, remoteFileService, sessionId) {
  const configuredCwd = String(session.cwd || "").trim();
  if (session.type === "windows" && path.win32.isAbsolute(configuredCwd)) {
    return path.win32.normalize(configuredCwd);
  }
  if (session.type !== "windows" && configuredCwd.startsWith("/")) {
    return path.posix.normalize(configuredCwd);
  }

  const home = await remoteFileService.getHome(sessionId);
  if (!configuredCwd || configuredCwd === "~") {
    return home;
  }
  if (session.type === "windows") {
    return path.win32.resolve(home, configuredCwd);
  }
  return path.posix.resolve(home, configuredCwd.replace(/^~\/?/, ""));
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

    const basePath = await resolveSessionWorkingDirectory(session, remoteFileService, sessionId);
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
  createImageFileName,
  resolveSessionWorkingDirectory
};
