function emptyGoalState() {
  return { available: false, active: null, latest: null, pendingAction: null, error: null, updatedAt: 0 };
}

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function readActive(value) {
  if (!value || typeof value.condition !== "string" || !value.condition.trim()) return null;
  return { condition: value.condition, paused: value.paused === true,
    durationMs: finiteNonnegative(value.durationMs), turnCount: finiteNonnegative(value.turnCount),
    tokenDelta: finiteNonnegative(value.tokenDelta),
    reason: typeof value.reason === "string" ? value.reason : "" };
}

function readLatest(value) {
  if (!value || typeof value.condition !== "string" || !value.condition.trim()) return null;
  return { condition: value.condition, ok: value.ok === true,
    reason: typeof value.reason === "string" ? value.reason : "",
    durationMs: finiteNonnegative(value.durationMs), turnCount: finiteNonnegative(value.turnCount),
    tokenDelta: finiteNonnegative(value.tokenDelta) };
}

function applyGoalUpdate(state, meta) {
  if (!meta || typeof meta !== "object") return false;
  const recap = meta["codebuddy.ai/goalRecap"];
  if (recap && typeof recap === "object") {
    state.updatedAt = Date.now();
    state.available = true;
    state.active = readActive(recap.active);
    state.latest = readLatest(recap.latest);
    state.pendingAction = null;
    state.error = null;
    return true;
  }
  const snapshot = meta["codebuddy.ai/sessionSnapshot"];
  if (snapshot && typeof snapshot === "object" && Object.hasOwn(snapshot, "activeGoal")) {
    state.updatedAt = Date.now();
    state.available = true;
    if (snapshot.activeGoal?.condition) {
      state.active = readActive({ ...snapshot.activeGoal,
        durationMs: Date.now() - snapshot.activeGoal.createdAt });
    } else state.active = null;
    state.pendingAction = null;
    return true;
  }
  const progress = meta["codebuddy.ai/goalProgress"];
  if (progress && typeof progress.condition === "string" && progress.condition.trim()) {
    state.updatedAt = Date.now();
    state.available = true;
    state.active = readActive({ ...state.active, condition: progress.condition, reason: progress.reason,
      turnCount: progress.turnCount, durationMs: state.active?.durationMs ?? Date.now() - progress.createdAt });
    state.pendingAction = null;
    return true;
  }
  const result = meta["codebuddy.ai/goalResult"];
  if (result && typeof result === "object" && result.condition) {
    state.updatedAt = Date.now();
    state.available = true;
    state.active = null;
    state.latest = readLatest(result);
    state.pendingAction = null;
    return true;
  }
  const status = meta["codebuddy.ai/goalStatus"];
  if (status && typeof status === "object" && typeof status.kind === "string") {
    state.updatedAt = Date.now();
    state.available = true;
    if (["set", "set-replaced", "resumed", "active"].includes(status.kind) && status.condition)
      state.active = readActive({ condition: status.condition, durationMs: Date.now() - status.createdAt });
    else if (status.kind === "paused" && state.active) state.active = { ...state.active, paused: true };
    else if (["cleared", "achieved", "impossible"].includes(status.kind)) state.active = null;
    state.pendingAction = null;
    return true;
  }
  return false;
}

module.exports = { emptyGoalState, applyGoalUpdate };
