const os = require("node:os");

function sanitizeHostLabel(input) {
  const value = String(input || "pc").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return value.slice(0, 45) || "pc";
}

function getMobileHostname() {
  return `pannel-handle-${sanitizeHostLabel(os.hostname())}.local`;
}

function isPrivateIpv4(address) {
  const parts = String(address || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function listPrivateInterfaces(networkInterfaces = os.networkInterfaces()) {
  const result = [];
  for (const [name, entries] of Object.entries(networkInterfaces)) {
    const ipv4 = (entries || []).find((entry) => entry.family === "IPv4" && !entry.internal && isPrivateIpv4(entry.address));
    if (ipv4) result.push({ name, address: ipv4.address });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

function createPairingUrls(state, nonce) {
  return {
    url: `${state.fallbackUrl}/#pair=${nonce}`,
    fallbackUrl: `${state.canonicalUrl}/#pair=${nonce}`
  };
}

module.exports = { sanitizeHostLabel, getMobileHostname, isPrivateIpv4, listPrivateInterfaces, createPairingUrls };
