function throwIfCancelled(task) {
  if (!task?.cancelled) return;
  const error = new Error("Project search was cancelled.");
  error.code = "SEARCH_CANCELLED";
  throw error;
}

function normalizeRequestId(requestId) {
  const value = String(requestId || "").trim();
  if (!value) {
    throw new Error("A search request ID is required.");
  }
  return value;
}

function createProcessError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  throwIfCancelled,
  normalizeRequestId,
  createProcessError
};
