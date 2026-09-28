const { createCodeBuddyAcpSessionService, buildInvocation } = require("../codebuddy-acp/session-service.cjs");

function createQoderAcpSessionService(options) {
  return createCodeBuddyAcpSessionService({ ...options, provider: "qoder" });
}

module.exports = { createQoderAcpSessionService, buildInvocation: (session, runtime, environment) =>
  buildInvocation(session, runtime, environment, "qoder") };
