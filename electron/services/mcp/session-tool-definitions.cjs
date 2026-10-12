const { z } = require("zod");
const SESSION_TOOLS = {
  list_session_instances: {
    description: "List currently running Pannel Handle session instances with connection, agent and recent activity status.",
    inputSchema: z.object({})
  },
  get_session_instance_status: {
    description: "Get the current status and recent activity summary for one running session instance.",
    inputSchema: z.object({ sessionId: z.string().min(1) })
  },
  list_session_templates: {
    description: "List saved templates configured with an Agent. Only graphical templates can create instances. Credentials are excluded.",
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  },
  create_session_instance: {
    description: "Create a new graphical Agent instance from a saved template, select model and plan/default mode, and submit the required prompt. Returns after submission, not task completion. Model overrides do not change the template. Each call creates a new instance; query status before retrying a timed-out call.",
    inputSchema: require("./session-instance-schema.cjs").sessionInstanceSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }
};
module.exports = { SESSION_TOOLS };
