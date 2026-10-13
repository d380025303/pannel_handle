const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const IMAGE_DIR_NAME = ".pannel-handle-images";
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];

function validateImageFile(name, size) {
  const ext = path.extname(name).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(ext)) throw new Error("不支持的图片格式。");
  if (!size) throw new Error("图片文件为空或无法读取。");
  if (size > MAX_IMAGE_SIZE) throw new Error("图片文件不能超过 10 MiB。");
  return ext;
}

function validateImageBytes(image) {
  if (!image || typeof image.name !== "string" || !(image.bytes instanceof Uint8Array)) {
    throw new Error("无效的图片文件。");
  }
  const ext = validateImageFile(image.name, image.bytes.byteLength);
  return { ext, buffer: Buffer.from(image.bytes) };
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function createImageFileName(now = new Date(), randomBytes = crypto.randomBytes, ext = ".png") {
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("");
  return `image-${stamp}-${randomBytes(3).toString("hex")}${ext}`;
}

function joinSessionPath(session, basePath, fileName) {
  if (session.type === "windows") {
    return path.win32.join(basePath, IMAGE_DIR_NAME, fileName);
  }
  return path.posix.join(basePath.replace(/\\/g, "/"), IMAGE_DIR_NAME, fileName);
}

async function resolveSessionWorkingDirectory(session, remoteFileService, sessionId) {
  if (session.type === "windows") {
    return remoteFileService.getHome(sessionId);
  }
  const configuredCwd = String(session.cwd || "").trim();
  if (configuredCwd.startsWith("/")) {
    return path.posix.normalize(configuredCwd);
  }

  const home = await remoteFileService.getHome(sessionId);
  if (!configuredCwd || configuredCwd === "~") {
    return home;
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
  validateImageFile("clipboard.png", buffer.length);
  return buffer;
}

function createClipboardImageService({
  clipboard,
  terminalManager,
  remoteFileService,
  now = () => new Date(),
  randomBytes = crypto.randomBytes
}) {
  async function pasteImageToSession(sessionId, { localCwd, image: fileImage } = {}) {
    let ext = ".png";
    let imageBuffer;
    if (fileImage !== undefined) {
      const validated = validateImageBytes(fileImage);
      ext = validated.ext;
      imageBuffer = validated.buffer;
    } else {
      imageBuffer = getPngBuffer(clipboard.readImage());
    }
    if (!imageBuffer) {
      return { status: "no_image" };
    }

    return saveImageToSession(sessionId, imageBuffer, ext, localCwd);
  }

  async function saveImageToSession(sessionId, imageBuffer, ext, localCwd) {
    const session = terminalManager.getSession(sessionId);
    if (!session) {
      throw new Error("Session is not running.");
    }

    if (localCwd) {
      const fileName = createImageFileName(now(), randomBytes, ext);
      const directory = path.win32.join(localCwd, IMAGE_DIR_NAME);
      await fs.promises.mkdir(directory, { recursive: true });
      const filePath = path.win32.join(directory, fileName);
      await fs.promises.writeFile(filePath, imageBuffer, { flag: "wx" });
      return { status: "saved", path: filePath, size: imageBuffer.length };
    }

    const basePath = await resolveSessionWorkingDirectory(session, remoteFileService, sessionId);
    const fileName = createImageFileName(now(), randomBytes, ext);
    const remotePath = joinSessionPath(session, basePath, fileName);
    const saved = await remoteFileService.writeBinaryFile(sessionId, remotePath, imageBuffer);
    return {
      status: "saved",
      path: saved.remotePath,
      size: imageBuffer.length
    };
  }

  async function uploadImageToSession(sessionId, localPath) {
    const session = terminalManager.getSession(sessionId);
    if (!session) {
      throw new Error("Session is not running.");
    }

    let file;
    try {
      file = await fs.promises.stat(localPath);
    } catch (error) {
      throw new Error(`无法读取图片文件：${error instanceof Error ? error.message : String(error)}`);
    }
    validateImageFile(localPath, file.size);

    let bytes;
    try {
      bytes = await fs.promises.readFile(localPath);
    } catch (error) {
      throw new Error(`无法读取图片文件：${error instanceof Error ? error.message : String(error)}`);
    }
    const { buffer, ext } = validateImageBytes({ name: localPath, bytes });
    return saveImageToSession(sessionId, buffer, ext);
  }

  return {
    pasteImageToSession,
    uploadImageToSession
  };
}

module.exports = {
  IMAGE_DIR_NAME,
  createClipboardImageService,
  createImageFileName,
  resolveSessionWorkingDirectory
};
