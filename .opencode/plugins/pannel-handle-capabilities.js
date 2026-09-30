export default {
  id: "pannel-handle-capabilities",
  async setup(ctx) {
    if (process.env.PANNEL_HANDLE_OPENCODE_CAPABILITIES !== "1") return;
    const hookUrl = process.env.PANNEL_HANDLE_HOOK_URL?.replace(/\/claude-hook$/, "/opencode-hook");
    if (!hookUrl) return;
    const { createServer } = await import("node:http");
    const token = crypto.randomUUID();
    const server = createServer(async (request, response) => {
      if (request.url !== "/capabilities" || request.method !== "GET"
        || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(404).end(); return; }
      const result = { skills: [], mcp: [], errors: {} };
      try {
        const value = await ctx.skill.list();
        const skills = Array.isArray(value) ? value : value?.items || value?.data || value?.skills || [];
        result.skills = skills.map(skill => ({ id: skill.id, name: skill.name, description: skill.description,
          path: skill.path || skill.location, enabled: skill.enabled, scope: skill.scope }));
      } catch (error) { result.errors.skills = String(error?.message || error); }
      try {
        const [servers, tools] = await Promise.all([ctx.mcp.list(), ctx.tool.list()]);
        const items = Array.isArray(servers) ? servers : servers?.items || servers?.data || servers?.servers || [];
        result.mcp = items.map(server => ({ name: server.name, status: server.status,
          error: typeof server.error === "string" ? server.error : server.error?.message || null }));
        const prefixes = result.mcp.filter(server => typeof server.name === "string")
          .map(server => `${server.name.replace(/[^A-Za-z0-9_]/g, "_")}_`);
        result.tools = tools.filter(tool => prefixes.some(prefix => tool.id?.startsWith(prefix)))
          .map(tool => ({ id: tool.id, description: tool.description }));
      } catch (error) { result.errors.mcp = String(error?.message || error); }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    });
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    const body = JSON.stringify({ event_name: "capabilities.endpoint", port: server.address().port, token,
      cwd: ctx.location.directory, pannel_handle_session_id: process.env.PANNEL_HANDLE_SESSION_ID });
    try {
      await fetch(hookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    } catch { /* The graphical session can still run when the hook receiver is unavailable. */ }
    return () => server.close();
  }
};
