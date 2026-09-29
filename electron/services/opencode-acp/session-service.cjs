const { createCodeBuddyAcpSessionService, buildInvocation } = require("../codebuddy-acp/session-service.cjs");

function normalizeCapabilities(raw) {
  const skills = Array.isArray(raw.skills) ? raw.skills : [];
  const servers = Array.isArray(raw.mcp) ? raw.mcp : Object.entries(raw.mcp || {}).map(([name, value]) => ({ name, ...value }));
  const tools = Array.isArray(raw.tools) ? raw.tools : [];
  return {
    skills: skills.filter(value => value && typeof value.id === "string").map(value => ({
      id: value.id, name: value.name || value.id, path: value.path || value.location || "",
      description: value.description || "", enabled: value.enabled !== false, scope: value.scope || ""
    })),
    apps: [],
    mcp: servers.filter(value => value && typeof value.name === "string").map(value => {
      const prefix = `${value.name.replace(/[^A-Za-z0-9_]/g, "_")}_`;
      const status = typeof value.status === "string" ? value.status : value.status?.type || "unknown";
      return { name: value.name, status, authStatus: "unknown", toolsError: value.error || null,
        tools: tools.filter(tool => typeof tool?.id === "string" && tool.id.startsWith(prefix))
          .map(tool => ({ name: tool.id, description: tool.description || "" })) };
    }),
    errors: { ...(raw.errors?.skills ? { skills: raw.errors.skills } : {}),
      ...(raw.errors?.mcp ? { mcp: raw.errors.mcp } : {}) }
  };
}

function createOpenCodeAcpSessionService(options) {
  const service = createCodeBuddyAcpSessionService({ ...options, provider: "opencode" });
  return { ...service,
    start(session, runtime) { options.clearCapabilityEndpoint?.(session.id); return service.start(session, runtime); },
    restart(id, ...args) { options.clearCapabilityEndpoint?.(id); return service.restart(id, ...args); },
    close(id) { options.clearCapabilityEndpoint?.(id); return service.close(id); },
    async listCapabilities(id) {
      const snapshot = service.snapshot(id);
      if (!snapshot.threadId) throw new Error("OpenCode 会话未就绪。");
      const endpoint = options.getCapabilityEndpoint?.(id);
      if (!endpoint) throw new Error("OpenCode 能力接口尚未就绪，请稍后刷新。");
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/capabilities`, {
        headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new Error(`OpenCode 能力读取失败（HTTP ${response.status}）。`);
      const raw = await response.json();
      if (service.snapshot(id).threadId !== snapshot.threadId) throw new Error("OpenCode 会话已切换，请重新打开能力列表。");
      return normalizeCapabilities(raw);
    } };
}

module.exports = { createOpenCodeAcpSessionService, normalizeCapabilities, buildInvocation: (session, runtime, environment) =>
  buildInvocation(session, runtime, environment, "opencode") };
