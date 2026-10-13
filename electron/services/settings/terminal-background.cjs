const fs = require("node:fs");
const path = require("node:path");

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

function copyBackgroundImage(sourcePath, userDataDir) {
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    throw new Error("Invalid source path");
  }
  const ext = path.extname(sourcePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported image type: ${ext}`);
  }
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size > MAX_IMAGE_SIZE_BYTES) {
    throw new Error("Image is too large or not a file");
  }
  const bgDir = path.join(userDataDir, TERMINAL_BG_DIR);
  fs.mkdirSync(bgDir, { recursive: true });
  const originalBase = path.basename(sourcePath);
  const baseWithoutExt = originalBase.slice(0, originalBase.length - path.extname(originalBase).length);
  // A trailing dot would form ".." when the extension is appended.
  const safeBase = baseWithoutExt.replace(/[^\w.-]+/g, "_").slice(0, 80).replace(/\.{2,}|\.$/g, "_") || "background";
  const name = `${Date.now()}-${safeBase}${ext}`;
  fs.copyFileSync(sourcePath, path.join(bgDir, name));
  return name;
}

module.exports = {
  TERMINAL_BG_SCHEME,
  TERMINAL_BG_DIR,
  ALLOWED_EXTENSIONS,
  MAX_IMAGE_SIZE_BYTES,
  isValidBackgroundName,
  registerTerminalBackgroundScheme,
  registerTerminalBackgroundProtocol,
  copyBackgroundImage
};
