const {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  createAutoCheckinScheduler
} = require("../auto-checkin-scheduler.cjs");

function getNextQoderWindowDelay(now = Date.now()) {
  return 86400000 - ((now - 7200000) % 86400000 + 86400000) % 86400000;
}

function createQoderAutoCheckinService(options) {
  const scheduler = createAutoCheckinScheduler({
    ...options,
    getNextCycleDelay: getNextQoderWindowDelay,
    notificationName: "Qoder"
  });
  return scheduler;
}

module.exports = {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  createQoderAutoCheckinService,
  getNextQoderWindowDelay
};
