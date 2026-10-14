const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const TERMINAL_BG_SCHEME = "terminal-bg";
const TERMINAL_BG_DIR = "terminal-background";
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;

function isValidBackgroundName(name) {
  return typeof name === "string"
    && name.length > 0
    && name.length <= 260
    && !name.includes("/")
    && !name.includes("\\")
    && !name.includes("..");
}

function registerTerminalBackgroundScheme(protocolApi) {
  protocolApi.registerSchemesAsPrivileged([{
    scheme: TERMINAL_BG_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }]);
}

function registerTerminalBackgroundProtocol(protocolApi, userDataDir) {
  const bgDir = path.join(userDataDir, TERMINAL_BG_DIR);
  protocolApi.registerFileProtocol(TERMINAL_BG_SCHEME, (request, callback) => {
    try {
      const url = new URL(request.url);
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      if (url.hostname !== "background" || !isValidBackgroundName(name)) {
        callback({ error: -6 }); // net::ERR_FILE_NOT_FOUND
        return;
      }
      const filePath = path.join(bgDir, name);
      if (!filePath.startsWith(bgDir + path.sep) || !fs.existsSync(filePath)) {
        callback({ error: -6 });
        return;
      }
      callback({ path: filePath });
    } catch {
      callback({ error: -6 });
    }
  });
}

async function copyBackgroundImage(sourcePath, userDataDir) {
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    throw new Error("Invalid source path");
  }
  const ext = path.extname(sourcePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported image type: ${ext}`);
  }
  const stat = await fs.promises.stat(sourcePath);
  if (!stat.isFile() || stat.size > MAX_IMAGE_SIZE_BYTES) {
    throw new Error("Image is too large or not a file");
  }
  const bgDir = path.join(userDataDir, TERMINAL_BG_DIR);
  await fs.promises.mkdir(bgDir, { recursive: true });
  const originalBase = path.basename(sourcePath);
  const baseWithoutExt = originalBase.slice(0, originalBase.length - path.extname(originalBase).length);
  // A trailing dot would form ".." when the extension is appended.
  const safeBase = baseWithoutExt.replace(/[^\w.-]+/g, "_").slice(0, 80).replace(/\.{2,}|\.$/g, "_") || "background";
  const name = `${Date.now()}-${safeBase}-${randomUUID()}${ext}`;
  await fs.promises.copyFile(sourcePath, path.join(bgDir, name), fs.constants.COPYFILE_EXCL);
  return name;
}

async function removeBackgroundImage(name, userDataDir) {
  if (!userDataDir || !isValidBackgroundName(name)
    || !ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase())
    || /[<>:"|?*\x00-\x1f]/.test(name)) return;
  const bgDir = path.resolve(userDataDir, TERMINAL_BG_DIR);
  const filePath = path.resolve(bgDir, name);
  if (path.dirname(filePath) !== bgDir) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Failed to remove terminal background image", error);
  }
}

module.exports = {
  TERMINAL_BG_SCHEME,
  TERMINAL_BG_DIR,
  ALLOWED_EXTENSIONS,
  MAX_IMAGE_SIZE_BYTES,
  isValidBackgroundName,
  registerTerminalBackgroundScheme,
  registerTerminalBackgroundProtocol,
  copyBackgroundImage,
  removeBackgroundImage
};
