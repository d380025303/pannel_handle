function isAgentPlanPending(payload) {
  return payload?.status === "completed" && payload.eventName === "AppServerPlanPending";
}

module.exports = { isAgentPlanPending };
