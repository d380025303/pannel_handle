const { createCodeBuddyAcpSessionService, buildInvocation } = require("../codebuddy-acp/session-service.cjs");

function createOpenCodeAcpSessionService(options) {
  return createCodeBuddyAcpSessionService({ ...options, provider: "opencode" });
}

module.exports = { createOpenCodeAcpSessionService, buildInvocation: (session, runtime, environment) =>
  buildInvocation(session, runtime, environment, "opencode") };
