const {
  TOKEN_FIELDS,
  normalizeCapabilityUsage,
  safeInteger
} = require("./agent-token-transcript.cjs");

function cloneTokens(tokens) {
  return Object.fromEntries(TOKEN_FIELDS.map(field => [field, safeInteger(tokens?.[field])]));
}

function subtractTokens(current, baseline) {
  return Object.fromEntries(TOKEN_FIELDS.map(field => [
    field,
    Math.max(0, safeInteger(current?.[field]) - safeInteger(baseline?.[field]))
  ]));
}

function capabilityItemsToMap(items) {
  return new Map((items || [])
    .map(item => [String(item?.name || "").trim(), safeInteger(item?.count)])
    .filter(([name]) => name));
}

function subtractCapabilities(current, baseline) {
  const normalized = normalizeCapabilityUsage(current);
  const base = normalizeCapabilityUsage(baseline, "unavailable");
  const skills = capabilityItemsToMap(normalized.skills.items);
  for (const [name, count] of capabilityItemsToMap(base.skills.items)) {
    skills.set(name, Math.max(0, (skills.get(name) || 0) - count));
  }
  const baselineServers = new Map((base.mcp.servers || [])
    .map(server => [server.name, capabilityItemsToMap(server.tools)]));
  const servers = normalized.mcp.servers.map(server => ({
    name: server.name,
    tools: server.tools.map(tool => ({
      name: tool.name,
      count: Math.max(0, tool.count - (baselineServers.get(server.name)?.get(tool.name) || 0))
    })).filter(tool => tool.count > 0)
  })).filter(server => server.tools.length > 0);
  return normalizeCapabilityUsage({
    skills: {
      availability: normalized.skills.availability,
      items: [...skills].map(([name, count]) => ({ name, count })).filter(item => item.count > 0)
    },
    mcp: { availability: normalized.mcp.availability, servers }
  });
}

module.exports = { cloneTokens, subtractCapabilities, subtractTokens };
