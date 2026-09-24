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

  function getTurn(sessionId) {
    const turn = turns.get(sessionId);
    return turn ? { ...turn, messages: turn.messages.map(message => ({ ...message })) } : null;
  }

  function sendSnapshot() {
    broadcast("agent-conversation:snapshot", getSnapshot());
  }

  function setActiveSession(sessionId) {
    activeSessionId = sessionId ? String(sessionId) : null;
    sendSnapshot();
  }

  function startTurn({ sessionId, sessionTitle, provider, supported, userMessage, userMessageId, timestamp = Date.now() }) {
    if (provider !== "codex" && provider !== "codebuddy" && provider !== "grok") return;
    const existingTurn = turns.get(sessionId);
    const messages = existingTurn?.messages || [];
    const currentTurnStartIndex = messages.length;
    const prompt = String(userMessage || "").trim();
    if (prompt) {
      const id = String(userMessageId || `user:${timestamp}:${prompt}`);
      if (!messages.some(message => message.id === id)) {
        messages.push({ id, provider, kind: "user", text: prompt, timestamp });
      }
    }
    turns.set(sessionId, {
      sessionId,
      sessionTitle: String(sessionTitle || provider),
      provider,
      status: supported ? "running" : "unsupported",
      supported: Boolean(supported),
      messages,
      currentTurnStartIndex
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

  function completeTurn(sessionId, finalMessage) {
    const turn = turns.get(sessionId);
    if (!turn || !turn.supported) return;
    const finalText = typeof finalMessage?.text === "string" ? finalMessage.text.trim() : "";
    const currentMessages = turn.messages.slice(turn.currentTurnStartIndex);
    const hasCurrentFinal = currentMessages.some(message => message.provider === "codex" && message.kind === "final");
    if (turn.provider === "codex" && finalText && !hasCurrentFinal) {
      turn.messages.push({
        id: String(finalMessage.id || `stop:${finalText}`),
        provider: "codex",
        kind: "final",
        text: finalText,
        timestamp: Number.isFinite(finalMessage.timestamp) ? finalMessage.timestamp : Date.now()
      });
    }
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
    getTurn,
    shutdown
  };
}

module.exports = {
  createAgentConversationManager
};
