function createTerminalSizeOwner({ terminalManager, stateHub, desktopBroadcast, getActiveSocket, send }) {
  const sizes = new Map();

  function getSizeState(sessionId) {
    let state = sizes.get(sessionId);
    if (!state) {
      const session = terminalManager.getSession(sessionId);
      const cols = Number(session?.cols || session?.term?.cols || 100);
      const rows = Number(session?.rows || session?.term?.rows || 30);
      state = { owner: "desktop", cols, rows, lastDesktop: { cols, rows } };
      sizes.set(sessionId, state);
    }
    return state;
  }

  function publishSize(sessionId) {
    const state = getSizeState(sessionId);
    const payload = { sessionId, owner: state.owner, cols: state.cols, rows: state.rows };
    desktopBroadcast("terminal:size-owner", payload);
    const socket = getActiveSocket();
    if (socket?.subscriptions?.has(sessionId)) send(socket, { type: "terminal.size-owner", ...payload });
  }

  function applySize(sessionId, owner, cols, rows) {
    const session = terminalManager.getSession(sessionId);
    if (!session) throw new Error("会话不存在或已经结束。");
    const nextCols = Math.max(20, Math.min(500, Math.floor(Number(cols))));
    const nextRows = Math.max(5, Math.min(200, Math.floor(Number(rows))));
    if (!Number.isFinite(nextCols) || !Number.isFinite(nextRows)) throw new Error("终端尺寸无效。");
    const state = getSizeState(sessionId);
    state.owner = owner;
    state.cols = nextCols;
    state.rows = nextRows;
    if (owner === "desktop") state.lastDesktop = { cols: nextCols, rows: nextRows };
    else state.lastMobile = { cols: nextCols, rows: nextRows };
    terminalManager.resize(sessionId, nextCols, nextRows);
    stateHub.resize(sessionId, nextCols, nextRows);
    publishSize(sessionId);
  }

  function resizeFromDesktop(sessionId, cols, rows) {
    const state = getSizeState(sessionId);
    state.lastDesktop = { cols, rows };
    if (state.owner === "desktop") applySize(sessionId, "desktop", cols, rows);
  }

  function claimDesktopSize(sessionId, cols, rows) {
    applySize(sessionId, "desktop", cols, rows);
  }

  function releaseDeviceSizes(deviceId) {
    for (const [sessionId, state] of sizes) {
      if (state.owner !== deviceId || !terminalManager.getSession(sessionId)) continue;
      const fallback = state.lastDesktop || { cols: 100, rows: 30 };
      applySize(sessionId, "desktop", fallback.cols, fallback.rows);
    }
  }
  function start(session) {
    sizes.set(session.id, { owner: "desktop", cols: session.cols, rows: session.rows, lastDesktop: { cols: session.cols, rows: session.rows } });
  }

  function observeResize(session) {
    const state = getSizeState(session.id);
    state.cols = session.cols;
    state.rows = session.rows;
    publishSize(session.id);
  }

  return { getSizeState, applySize, resizeFromDesktop, claimDesktopSize, releaseDeviceSizes, start, observeResize, remove: sessionId => sizes.delete(sessionId) };
}

module.exports = { createTerminalSizeOwner };
