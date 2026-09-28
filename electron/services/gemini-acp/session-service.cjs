const { createCodeBuddyAcpSessionService, buildInvocation } = require("../codebuddy-acp/session-service.cjs");

function createGeminiAcpSessionService(options) {
  return createCodeBuddyAcpSessionService({ ...options, provider: "gemini" });
}

module.exports = { createGeminiAcpSessionService, buildInvocation: (session, runtime, environment) =>
  buildInvocation(session, runtime, environment, "gemini") };
