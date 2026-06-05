const http = require("node:http");
const path = require("node:path");

function createAgentHookServer({ terminalManager }) {
  const agentSessions = {
    claude: new Map(),
    codex: new Map()
  };
  let hookServer = null;
  let claudeHookUrl = "";

  function normalizeCwd(value) {
    if (typeof value !== "string" || value.length === 0) {
      return "";
    }
    return path.resolve(value).toLowerCase();
  }

  function getAgentSessionId(input) {
    return input.session_id || input.sessionId;
  }

  function getPanelSessionId(input) {
    return input.pannel_handle_session_id || input.panelSessionId;
  }

  function registerAgentSession(provider, agentSessionId, sessionId) {
    if (typeof agentSessionId === "string" && agentSessionId.length > 0) {
      agentSessions[provider].set(agentSessionId, sessionId);
    }
  }

  function findSessionForAgentHook(provider, input) {
    const panelSessionId = getPanelSessionId(input);
    const agentSessionId = getAgentSessionId(input);

    if (typeof panelSessionId === "string" && terminalManager.getSession(panelSessionId)) {
      registerAgentSession(provider, agentSessionId, panelSessionId);
      return terminalManager.getSession(panelSessionId);
    }

    if (typeof agentSessionId === "string") {
      const mappedId = agentSessions[provider].get(agentSessionId);
      if (mappedId && terminalManager.getSession(mappedId)) {
        return terminalManager.getSession(mappedId);
      }
    }

    const hookCwd = normalizeCwd(input.cwd);
    if (hookCwd) {
      const cwdMatches = terminalManager.getSessions().filter(session => normalizeCwd(session.cwd) === hookCwd);
      if (cwdMatches.length === 1) {
        registerAgentSession(provider, agentSessionId, cwdMatches[0].id);
        return cwdMatches[0];
      }
    }

    const sessions = terminalManager.getSessions();
    if (sessions.length === 1) {
      const [session] = sessions;
      registerAgentSession(provider, agentSessionId, session.id);
      return session;
    }

    return null;
  }

  function isToolFailure(input) {
    return (
      input.is_error === true ||
      input.isError === true ||
      (typeof input.error === "object" && input.error !== null) ||
      (typeof input.error === "string" && input.error.length > 0) ||
      input.success === false
    );
  }

  function getEventName(input) {
    return input.hook_event_name || input.eventName || input.event_name || "Unknown";
  }

  function mapClaudeHookStatus(input) {
    const eventName = getEventName(input);
    const notificationType = input.notification_type || input.notificationType;

    if (eventName === "PermissionRequest") {
      return "waiting_for_permission";
    }
    if (eventName === "UserPromptSubmit" || eventName === "PreToolUse") {
      return "running";
    }
    if (eventName === "Notification" && notificationType === "permission_prompt") {
      return "waiting_for_permission";
    }
    if (eventName === "Notification" && notificationType === "idle_prompt") {
      return "e_prompt";
    }
    if (eventName === "PostToolUse") {
      if (isToolFailure(input)) {
        return "failed";
      }
      return "running";
    }
    if (eventName === "Stop") {
      return "completed";
    }
    if (eventName === "StopFailure") {
      return "failed";
    }
    if (eventName === "SessionEnd") {
      return "ended";
    }
    return null;
  }

  function getClaudeHookResolution(input) {
    const eventName = getEventName(input);

    if (eventName === "Stop") {
      return "none";
    }
    if (eventName === "StopFailure") {
      return "none";
    }
    if (eventName === "SessionEnd") {
      return "none";
    }
    if (eventName === "PostToolUse" && isToolFailure(input)) {
      return "provide_input";
    }
    return undefined;
  }

  function mapCodexHookStatus(input) {
    const eventName = getEventName(input);

    if (eventName === "PermissionRequest") {
      return "waiting_for_permission";
    }
    if (
      eventName === "SessionStart" ||
      eventName === "UserPromptSubmit" ||
      eventName === "PreToolUse" ||
      eventName === "PostToolUse"
    ) {
      return "running";
    }
    if (eventName === "Stop") {
      return "completed";
    }
    return null;
  }

  function getHookStatus(provider, input) {
    if (provider === "codex") {
      return mapCodexHookStatus(input);
    }
    return mapClaudeHookStatus(input);
  }

  function readJsonRequest(req, callback) {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        callback(null, JSON.parse(body || "{}"));
      } catch (err) {
        callback(err);
      }
    });
  }

  function handleAgentHook(provider, input) {
    const session = findSessionForAgentHook(provider, input);
    if (!session) {
      return false;
    }

    const eventName = getEventName(input);
    const status = getHookStatus(provider, input);
    if (!status) {
      return false;
    }
    const toolName = input.tool_name || input.toolName || input.tool;
    const message = input.message || input.title || input.notification_type || input.reason;
    registerAgentSession(provider, getAgentSessionId(input), session.id);
    const resolution = getClaudeHookResolution(input);
    session.agentStatus = status;
    session.agentProvider = provider;

    terminalManager.broadcastAgentStatus({
      id: session.id,
      provider,
      status,
      eventName,
      message,
      toolName,
      toolInput: input.tool_input || input.toolInput,
      lastAssistantMessage: input.last_assistant_message || input.lastAssistantMessage,
      ...(resolution !== undefined ? { resolution } : {})
    });
    return true;
  }

  function handleAgentHookDebug(provider, input) {
    const session = findSessionForAgentHook(provider, input);
    const handled = handleAgentHook(provider, input);
    if (typeof terminalManager.broadcastAgentHookDebug === "function") {
      terminalManager.broadcastAgentHookDebug({
        provider,
        eventName: getEventName(input),
        matchedSessionId: session?.id,
        handled,
        payload: input
      });
    }
    return handled;
  }

  function handleRequest(provider, req, res) {
    readJsonRequest(req, (err, input) => {
      if (err) {
        res.writeHead(400);
        res.end("invalid json");
        return;
      }

      handleAgentHookDebug(provider, input);
      res.writeHead(204);
      res.end();
    });
  }

  function start() {
    if (hookServer) {
      return;
    }

    hookServer = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/claude-hook") {
        handleRequest("claude", req, res);
        return;
      }
      if (req.method === "POST" && req.url === "/codex-hook") {
        handleRequest("codex", req, res);
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });

    hookServer.listen(0, "127.0.0.1", () => {
      const address = hookServer.address();
      if (address && typeof address === "object") {
        claudeHookUrl = `http://127.0.0.1:${address.port}/claude-hook`;
      }
    });

    hookServer.on("error", (err) => {
      console.error("Failed to run agent hook server:", err);
    });
  }

  function stop() {
    if (hookServer) {
      hookServer.close();
      hookServer = null;
      claudeHookUrl = "";
    }
  }

  function getHookUrl() {
    return claudeHookUrl;
  }

  return {
    start,
    stop,
    getHookUrl,
    handleAgentHook,
    handleAgentHookDebug
  };
}

module.exports = {
  createAgentHookServer
};
