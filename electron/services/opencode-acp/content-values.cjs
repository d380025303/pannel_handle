const path = require("node:path");
const { pathToFileURL } = require("node:url");

const FILE_MIME = {
  ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
  ".csv": "text/csv", ".html": "text/html", ".css": "text/css",
  ".js": "text/javascript", ".ts": "text/plain", ".tsx": "text/plain",
  ".py": "text/x-python", ".pdf": "application/pdf", ".xml": "application/xml",
  ".zip": "application/zip"
};

function fileResourceLink(file, size) {
  // POSIX paths belong to the Agent, even when the client runs on Windows.
  const uri = file.startsWith("/")
    ? `file://${file.split("/").map(segment => encodeURIComponent(segment)).join("/")}`
    : pathToFileURL(file).href;
  return { type: "resource_link", uri,
    name: file.startsWith("/") ? path.posix.basename(file) : path.basename(file),
    mimeType: FILE_MIME[path.extname(file).toLowerCase()] || "application/octet-stream", size };
}

function applyStructuredToolUpdate(item, update) {
  if (update.rawInput != null) item.arguments = update.rawInput;
  if (update.rawOutput != null) item.result = update.rawOutput;
  if (Array.isArray(update.content)) {
    item.toolContent = update.content;
    item.output = update.content.map(block => block?.content?.text || block?.content?.uri || block?.text || "")
      .filter(Boolean).join("\n");
  }
  if (Array.isArray(update.locations)) item.locations = update.locations.map(location => ({
    path: location.path, uri: location.uri,
    ...(Number.isInteger(location.line) && location.line >= 0 ? { line: location.line } : {})
  }));
}

function resourceAttachment(content) {
  const resource = content?.type === "resource_link" ? content : content?.type === "resource" ? content.resource : null;
  if (typeof resource?.uri !== "string") return null;
  try {
    const url = new URL(resource.uri);
    if (url.protocol !== "file:") return null;
    const pathname = decodeURIComponent(url.pathname);
    const file = url.hostname ? `\\\\${url.hostname}${pathname.replace(/\//g, "\\")}`
      : /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1).replace(/\//g, "\\") : pathname;
    return { path: file, name: typeof resource.name === "string" ? resource.name
      : file.startsWith("/") ? path.posix.basename(file) : path.win32.basename(file) };
  } catch { return null; }
}

module.exports = { fileResourceLink, applyStructuredToolUpdate, resourceAttachment };
