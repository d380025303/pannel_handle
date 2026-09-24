const MAX_INPUT_BYTES = 16 * 1024;
const SUBMIT_DELAY_MS = 200;

function createCodexSessionControl({ terminalManager, stateHub, conversationManager, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  function getSession(sessionId) {
    const id = String(sessionId || "");
    const session = terminalManager.getSession(id);
    if (!session || (session.agentRuntimeProvider || session.agentProvider) !== "codex" || !session.term || session.closing || session.agentStatus === "ended") {
      throw new Error("Codex 会话不存在或已结束。");
    }
    if (session.type === "ssh" && session.sshConnectionState !== "connected") {
      throw new Error("Codex SSH 会话尚未连接。");
    }
    return session;
  }

  function listSessions() {
    return terminalManager.listSessions().filter(item => {
      try { getSession(item.id); return true; } catch { return false; }
    }).map(item => ({ id: item.id, title: item.title, type: item.type, cwd: item.cwd,
      status: terminalManager.getSession(item.id)?.agentStatus || "unknown" }));
  }

  async function getScreen(sessionId) {
    const session = getSession(sessionId);
    const screen = await stateHub.getSnapshot(session.id);
    getSession(session.id);
    if (!screen) throw new Error("终端画面尚未就绪。");
    return screen;
  }

  function getDeltas(sessionId, afterSeq) {
    getSession(sessionId);
    return stateHub.getDeltas(sessionId, afterSeq);
  }

  function write(sessionId, data) {
    const session = getSession(sessionId);
    if (typeof data !== "string" || !data || Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES) {
      throw new Error("终端输入必须为 1–16384 字节。");
    }
    terminalManager.write(session.id, data);
  }

  async function submit(sessionId, text) {
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) {
      throw new Error("请输入有效的文本内容。");
    }
    write(sessionId, text);
    await delay(SUBMIT_DELAY_MS);
    write(sessionId, "\r");
  }

  function switchMode(sessionId) {
    write(sessionId, "\x1b[Z");
  }

  async function getContext(sessionId) {
    const session = getSession(sessionId);
    const screenText = await stateHub.getText(session.id, 80);
    getSession(session.id);
    const turn = conversationManager?.getTurn?.(session.id);
    return {
      session: { id: session.id, title: session.title, type: session.type, cwd: session.cwd, status: session.agentStatus || "unknown" },
      messages: (turn?.messages || []).slice(-20).map(({ kind, text, timestamp }) => ({ kind, text: String(text).slice(0, 2000), timestamp })),
      screenText
    };
  }

  return { listSessions, getScreen, getDeltas, write, submit, switchMode, getContext };
}

module.exports = { createCodexSessionControl, MAX_INPUT_BYTES, SUBMIT_DELAY_MS };
