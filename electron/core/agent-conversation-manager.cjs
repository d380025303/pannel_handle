function createAgentConversationManager({ broadcast }) {
  const turns = new Map();
  let activeSessionId = null;

  function getSnapshot() {
    const turn = activeSessionId ? turns.get(activeSessionId) : null;
    return {
      activeSessionId,
      turn: turn ? {
        sessionId: turn.sessionId,
        sessionTitle: turn.sessionTitle,
        provider: turn.provider,
        status: turn.status,
        supported: turn.supported,
        messages: turn.messages.map(message => ({ ...message }))
      } : null
    };
  }

  function sendSnapshot() {
    broadcast("agent-conversation:snapshot", getSnapshot());
  }

  function setActiveSession(sessionId) {
    activeSessionId = sessionId ? String(sessionId) : null;
    sendSnapshot();
  }

  function startTurn({ sessionId, sessionTitle, provider, supported }) {
    if (provider !== "codex" && provider !== "codebuddy") return;
    const existingTurn = turns.get(sessionId);
    turns.set(sessionId, {
      sessionId,
      sessionTitle: String(sessionTitle || provider),
      provider,
      status: supported ? "running" : "unsupported",
      supported: Boolean(supported),
      messages: existingTurn?.messages || []
    });
    if (activeSessionId === sessionId) sendSnapshot();
  }

  function appendMessages(sessionId, messages) {
    const turn = turns.get(sessionId);
    if (!turn || !turn.supported || !Array.isArray(messages)) return;
    const ids = new Set(turn.messages.map(message => message.id));
    for (const message of messages) {
      if (!message?.id || !message.text || ids.has(message.id)) continue;
      ids.add(message.id);
      turn.messages.push({ ...message });
    }
    if (activeSessionId === sessionId) sendSnapshot();
  }

  function completeTurn(sessionId) {
    const turn = turns.get(sessionId);
    if (!turn || !turn.supported) return;
    turn.status = "completed";
    if (activeSessionId === sessionId) sendSnapshot();
  }

  function clearSession(sessionId) {
    turns.delete(sessionId);
    if (activeSessionId === sessionId) sendSnapshot();
  }

  function shutdown() {
    turns.clear();
    activeSessionId = null;
  }

  return {
    setActiveSession,
    startTurn,
    appendMessages,
    completeTurn,
    clearSession,
    getSnapshot,
    shutdown
  };
}

module.exports = {
  createAgentConversationManager
};
