const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const DEFAULT_SCROLLBACK = 5000;
const MAX_DELTA_BYTES = 2 * 1024 * 1024;

function createTerminalStateHub({ scrollback = DEFAULT_SCROLLBACK, maxDeltaBytes = MAX_DELTA_BYTES } = {}) {
  const states = new Map();

  function createState(id, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
    const terminal = new Terminal({
      cols: Math.max(2, Math.floor(cols)),
      rows: Math.max(1, Math.floor(rows)),
      scrollback,
      allowProposedApi: true
    });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    const state = {
      id,
      terminal,
      serializer,
      seq: 0,
      deltas: [],
      deltaBytes: 0,
      pending: Promise.resolve()
    };
    states.set(id, state);
    return state;
  }

  function ensure(id, cols, rows) {
    return states.get(id) || createState(id, cols, rows);
  }

  function start(id, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
    const previous = states.get(id);
    if (previous) previous.terminal.dispose();
    return createState(id, cols, rows);
  }

  function write(id, data, cols, rows) {
    const state = ensure(id, cols, rows);
    const text = String(data || "");
    if (!text) return state.seq;
    state.seq += 1;
    const event = { seq: state.seq, data: text };
    state.deltas.push(event);
    state.deltaBytes += Buffer.byteLength(text, "utf8");
    while (state.deltas.length > 1 && state.deltaBytes > maxDeltaBytes) {
      const removed = state.deltas.shift();
      state.deltaBytes -= Buffer.byteLength(removed.data, "utf8");
    }
    state.pending = state.pending.then(() => new Promise((resolve) => state.terminal.write(text, resolve)));
    return state.seq;
  }

  function resize(id, cols, rows) {
    const state = ensure(id, cols, rows);
    const nextCols = Math.max(2, Math.floor(cols));
    const nextRows = Math.max(1, Math.floor(rows));
    if (state.terminal.cols !== nextCols || state.terminal.rows !== nextRows) {
      state.terminal.resize(nextCols, nextRows);
    }
  }

  async function getSnapshot(id, owner = "desktop") {
    const state = states.get(id);
    if (!state) return null;
    await state.pending;
    return {
      sessionId: id,
      ansi: state.serializer.serialize({ scrollback: scrollback > 0 }),
      seq: state.seq,
      cols: state.terminal.cols,
      rows: state.terminal.rows,
      owner
    };
  }

  function getDeltas(id, afterSeq) {
    const state = states.get(id);
    if (!state || !Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > state.seq) return null;
    if (afterSeq === state.seq) return [];
    const first = state.deltas[0]?.seq;
    if (!first || afterSeq < first - 1) return null;
    return state.deltas.filter((event) => event.seq > afterSeq);
  }

  function getSequence(id) {
    return states.get(id)?.seq || 0;
  }

  function remove(id) {
    const state = states.get(id);
    if (state) state.terminal.dispose();
    states.delete(id);
  }

  function shutdown() {
    for (const state of states.values()) state.terminal.dispose();
    states.clear();
  }

  return { start, ensure, write, resize, getSnapshot, getDeltas, getSequence, remove, shutdown };
}

module.exports = {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_SCROLLBACK,
  MAX_DELTA_BYTES,
  createTerminalStateHub
};
