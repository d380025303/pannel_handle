const { createConversationArchiveStore } = require("./conversation-archive-store.cjs");

const { savedMessage } = require("./saved-message.cjs");
function graphicalMessage(item, provider, timestamp) {
  if (item?.type === "contextCompaction") {
    const summary = item.compactionSummary || item.summary;
    const text = typeof item.text === "string" && item.text.trim() ? item.text
      : Array.isArray(summary) ? summary.map(part => typeof part === "string" ? part : part?.text || "").filter(Boolean).join("\n\n")
      : typeof summary === "string" ? summary : "";
    return savedMessage({ id: item.id, provider, kind: "summary", text, timestamp, turnId: item.turnId });
  }
  if (!["userMessage", "agentMessage"].includes(item?.type)) return null;
  let text = typeof item.text === "string" ? item.text : "";
  if (item.type === "userMessage" && item.attachments?.length)
    text += `\n${item.attachments.map(file => `[附件] ${file.name || file.path}`).join("\n")}`;
  return savedMessage({ id: item.id, provider, kind: item.type === "userMessage" ? "user" : "reply",
    text, timestamp, turnId: item.turnId, phase: item.phase });
}

function createConversationArchiveService({ userData, getHistoryService, store, now = Date.now }) {
  let initializationError;
  if (!store) {
    try { store = createConversationArchiveStore({ userData }); }
    catch (error) { initializationError = `本地留档数据库无法打开：${error.message}`; console.error(initializationError); }
  }
  const active = new Map();
  const draining = new Set();
  const failures = new Map();
  let stopped = false;
  function guard(sessionId, action) {
    if (initializationError) { failures.set(sessionId, initializationError); return; }
    try { return action(); }
    catch (error) {
      failures.set(sessionId, `本地留档保存失败：${error.message}`);
      console.error("Conversation archive failed:", error);
    }
  }
  function start(session) {
    if (!session.agentProvider || active.has(session.id)) return;
    guard(session.id, () => {
      const state = { id: store.start(session), session: { ...session }, startedAt: now(),
        threads: new Map(), activeThread: null, terminalThreads: new Set(), polling: null, closed: false };
      active.set(session.id, state);
      if (session.runtimeMode !== "app-server") void poll(state);
    });
  }
  // Called immediately before submitting, so restored history never becomes new archived messages.
  function baseline(id, snapshot) {
    const state = active.get(id);
    if (!state || !snapshot.threadId) return;
    guard(id, () => {
      store.associate(state.id, snapshot.threadId);
      state.activeThread = snapshot.threadId;
      let thread = state.threads.get(snapshot.threadId);
      if (!thread) { thread = { ignored: new Set(), saved: new Map() }; state.threads.set(snapshot.threadId, thread); }
      for (const item of snapshot.items || []) if (!thread.saved.has(item.id)) thread.ignored.add(item.id);
      store.captureStatus(state.id, "supported");
    });
  }
  function graphical(id, snapshot) {
    const state = active.get(id);
    if (!state || state.closed) return;
    guard(id, () => {
      store.associate(state.id, snapshot.threadId);
      if (snapshot.threadId) state.graphicalReady = true;
      if (snapshot.error) store.captureStatus(state.id, "error", snapshot.error);
      if (state.activeThread !== snapshot.threadId) return;
      const thread = state.threads.get(snapshot.threadId);
      if (!thread) return;
      const messages = [];
      for (const item of snapshot.items || []) {
        if (thread.ignored.has(item.id)) continue;
        const old = thread.saved.get(item.id);
        const message = graphicalMessage(item, state.session.agentProvider, old?.timestamp || now());
        if (!message) continue;
        if (JSON.stringify(message) === JSON.stringify(old)) continue;
        messages.push(message);
      }
      if (messages.length) {
        store.save(state.id, snapshot.threadId, messages);
        for (const message of messages) thread.saved.set(message.id, message);
        failures.delete(id);
      }
    });
  }
  function bindThread(id, provider, threadId) {
    const state = active.get(id);
    if (!state || state.closed || state.session.runtimeMode === "app-server" || !threadId || provider !== state.session.agentProvider) return;
    state.terminalThreads.add(`${provider}:${threadId}`);
    guard(id, () => store.associate(state.id, `${provider}:${threadId}`));
    void poll(state);
  }
  async function poll(state) {
    if (stopped) return;
    if (state.polling) return state.polling;
    if (!state.terminalThreads.size || !["codex", "codebuddy", "opencode", "gemini", "grok"].includes(state.session.agentProvider)) return;
    const history = getHistoryService();
    if (!history) return;
    state.polling = (async () => {
      try {
        let cursor = null;
        do {
          const page = await history.listHistoryForSession(state.session, { providers: [state.session.agentProvider], scope: "cwd", includeArchived: true, cursor, limit: 200 });
          if (stopped) return;
          if (page.errors?.length) throw new Error(page.errors.map(value => value.message).join("; "));
          for (const item of page.items) {
            if (!(state.terminalThreads.has(item.ref) || item.acpSessionId && state.terminalThreads.has(`${item.provider}:${item.acpSessionId}`))) continue;
            let messageCursor = null;
            const messages = [];
            do {
              const detail = await history.getHistoryMessagesForSession(state.session, { conversationRef: item.ref, cursor: messageCursor, limit: 200 });
              if (stopped) return;
              messages.push(...detail.messages.filter(message => message.timestamp >= state.startedAt));
              messageCursor = detail.nextCursor;
            } while (messageCursor);
            // Persist oldest first; source timestamps only decide the launch boundary.
            messages.sort((a, b) => a.timestamp - b.timestamp);
            guard(state.session.id, () => {
              store.save(state.id, item.ref, messages);
              store.captureStatus(state.id, "supported");
              failures.delete(state.session.id);
            });
          }
          cursor = page.nextCursor;
        } while (cursor);
      } catch (error) {
        if (!stopped) guard(state.session.id, () => store.captureStatus(state.id, "error", `对话采集失败：${error.message}`));
      }
    })();
    try { await state.polling; } finally { state.polling = null; }
  }
  function finish(id, status = "ended") {
    const state = active.get(id);
    if (!state) return;
    state.closed = true;
    active.delete(id);
    guard(id, () => store.finish(state.id, state.session.runtimeMode === "app-server" && !state.graphicalReady ? "failed" : status));
    if (state.session.runtimeMode !== "app-server") {
      const finalRead = (async () => { await state.polling; await poll(state); })();
      draining.add(finalRead);
      void finalRead.finally(() => draining.delete(finalRead));
    }
  }
  const timer = setInterval(() => {
    for (const state of active.values()) if (state.session.runtimeMode !== "app-server") void poll(state);
  }, 5000);
  timer.unref?.();
  return { start, baseline, graphical, bindThread, finish,
    pause(id) { const state = active.get(id); if (state) state.activeThread = null; },
    async flush() {
      const reads = [...draining];
      for (const state of active.values()) {
        if (state.session.runtimeMode !== "app-server") reads.push((async () => { await state.polling; await poll(state); })());
      }
      let timeout;
      try { await Promise.race([Promise.allSettled(reads), new Promise(resolve => { timeout = setTimeout(resolve, 3000); })]); }
      finally { clearTimeout(timeout); }
    },
    list(input) {
      if (initializationError) return { items: [], nextCursor: null, errors: [{ provider: "codex", message: initializationError }] };
      const result = store.list(input);
      for (const [id, message] of failures) result.errors.push({ provider: active.get(id)?.session.agentProvider || "codex", message });
      return result;
    }, read: input => { if (initializationError) throw new Error(initializationError); return store.read(input); },
    shutdown() {
      stopped = true; clearInterval(timer);
      for (const state of active.values()) guard(state.session.id, () => store.finish(state.id, "interrupted"));
      active.clear(); store?.close();
    }
  };
}
module.exports = { createConversationArchiveService, graphicalMessage };
