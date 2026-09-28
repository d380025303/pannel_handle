const { createCodeBuddyAcpSessionService, buildInvocation } = require("../codebuddy-acp/session-service.cjs");

function createClaudeAcpSessionService(options) {
  return createCodeBuddyAcpSessionService({ ...options, provider: "claude" });
}

module.exports = { createClaudeAcpSessionService, buildInvocation: (session, runtime, environment) =>
  buildInvocation(session, runtime, environment, "claude") };
