class WorkBuddyCheckinError extends Error {
  constructor(message, { code = "checkin-failed", retryable = true } = {}) {
    super(message);
    this.name = "WorkBuddyCheckinError";
    this.code = code;
    this.retryable = retryable;
  }
}

function createCheckinError(message, options) {
  return new WorkBuddyCheckinError(message, options);
}

module.exports = {
  WorkBuddyCheckinError,
  createCheckinError
};
