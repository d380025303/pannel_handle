function normalizeExternalHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("An external URL is required.");
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("The external URL is invalid.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS external URLs are allowed.");
  }

  return url.href;
}

async function openExternalHttpUrl(shellApi, value) {
  if (!shellApi || typeof shellApi.openExternal !== "function") {
    throw new Error("The external browser service is unavailable.");
  }

  const url = normalizeExternalHttpUrl(value);
  await shellApi.openExternal(url);
}

module.exports = {
  normalizeExternalHttpUrl,
  openExternalHttpUrl
};
