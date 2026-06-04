const http = require("node:http");
const path = require("node:path");

function createClaudeHookServer({ terminalManager }) {
  const claudeSessions = new Map();
  let claudeHookServer = null;
  let claudeHookUrl = "";

  function normalizeCwd(value) {
    if (typeof value !== "string" || value.length === 0) {
      return "";
    }
    return path.resolve(value).toLowerCase();
  }

  function registerClaudeSession(claudeSessionId, sessionId) {
    if (typeof claudeSessionId === "string" && claudeSessionId.length > 0) {
      claudeSessions.set(claudeSessionId, sessionId);
    }
  }

  function findSessionForClaudeHook(input) {
    const panelSessionId = input.pannel_handle_session_id || input.panelSessionId;
    if (typeof panelSessionId === "string" && terminalManager.getSession(panelSessionId)) {
      registerClaudeSession(input.session_id || input.sessionId, panelSessionId);
      return terminalManager.getSession(panelSessionId);
    }

    const claudeSessionId = input.session_id || input.sessionId;
    if (typeof claudeSessionId === "string") {
      const mappedId = claudeSessions.get(claudeSessionId);
      if (mappedId && terminalManager.getSession(mappedId)) {
        return terminalManager.getSession(mappedId);
      }
    }

    const hookCwd = normalizeCwd(input.cwd);
    if (hookCwd) {
      const cwdMatches = terminalManager.getSessions().filter(session => normalizeCwd(session.cwd) === hookCwd);
      if (cwdMatches.length === 1) {
        registerClaudeSession(claudeSessionId, cwdMatches[0].id);
        return cwdMatches[0];
      }
    }

    const sessions = terminalManager.getSessions();
    if (sessions.length === 1) {
      const [session] = sessions;
      registerClaudeSession(claudeSessionId, session.id);
      return session;
    }

    return null;
  }

  function mapClaudeHookStatus(input) {
    const eventName = input.hook_event_name || input.eventName || input.event_name;
    const notificationType = input.notification_type || input.notificationType;

    if (eventName === "PermissionRequest") {
      return "waiting_for_permission";
    }
    if (eventName === "Notification" && notificationType === "permission_prompt") {
      return "waiting_for_permission";
    }
    if (eventName === "Notification" && notificationType === "idle_prompt") {
      return "completed";
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
    return "running";
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

  function handleClaudeHook(input) {
    const session = findSessionForClaudeHook(input);
    if (!session) {
      return false;
    }

    const eventName = input.hook_event_name || input.eventName || input.event_name || "Unknown";
    const status = mapClaudeHookStatus(input);
    const toolName = input.tool_name || input.toolName;
    const message = input.message || input.title || input.notification_type || input.reason;
    registerClaudeSession(input.session_id || input.sessionId, session.id);
    session.agentStatus = status;

    terminalManager.broadcastAgentStatus({
      id: session.id,
      status,
      eventName,
      message,
      toolName,
      toolInput: input.tool_input || input.toolInput,
      lastAssistantMessage: input.last_assistant_message || input.lastAssistantMessage
    });
    return true;
  }

  function start() {
    if (claudeHookServer) {
      return;
    }

    claudeHookServer = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/claude-hook") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      readJsonRequest(req, (err, input) => {
        if (err) {
          res.writeHead(400);
          res.end("invalid json");
          return;
        }

        handleClaudeHook(input);
        res.writeHead(204);
        res.end();
      });
    });

    claudeHookServer.listen(0, "127.0.0.1", () => {
      const address = claudeHookServer.address();
      if (address && typeof address === "object") {
        claudeHookUrl = `http://127.0.0.1:${address.port}/claude-hook`;
      }
    });

    claudeHookServer.on("error", (err) => {
      console.error("Failed to run Claude hook server:", err);
    });
  }

  function stop() {
    if (claudeHookServer) {
      claudeHookServer.close();
      claudeHookServer = null;
      claudeHookUrl = "";
    }
  }

  function getHookUrl() {
    return claudeHookUrl;
  }

  return {
    start,
    stop,
    getHookUrl
  };
}

module.exports = {
  createClaudeHookServer
};
