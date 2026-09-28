const { createCodeBuddyAcpSessionService, buildInvocation } = require("../codebuddy-acp/session-service.cjs");

function createGrokAcpSessionService(options) {
  return createCodeBuddyAcpSessionService({ ...options, provider: "grok" });
}

module.exports = { createGrokAcpSessionService, buildInvocation: (session, runtime, environment) =>
  buildInvocation(session, runtime, environment, "grok") };
