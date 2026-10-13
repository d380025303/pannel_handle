const {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  createAutoCheckinScheduler
} = require("../auto-checkin-scheduler.cjs");

function getNextLocalDayDelay(now = Date.now()) {
  const nextDay = new Date(now);
  nextDay.setHours(24, 0, 0, 0);
  return Math.max(1000, nextDay.getTime() - now);
}

function createWorkBuddyAutoCheckinService(options) {
  const scheduler = createAutoCheckinScheduler({
    ...options,
    getNextCycleDelay: getNextLocalDayDelay,
    notificationName: "WorkBuddy"
  });
  const { setEnabled, shutdown, start } = scheduler;
  return { setEnabled, shutdown, start };
}

module.exports = {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  createWorkBuddyAutoCheckinService,
  getNextLocalDayDelay
};
