const { createAgentHookServer } = require("./agent-hook-server.cjs");

function createClaudeHookServer(options) {
  return createAgentHookServer(options);
}

module.exports = {
  createClaudeHookServer
};
