function createGeminiMessageState() {
  const messages = new Map();
  function apply(item) {
    if (Array.isArray(item?.$set?.messages)) {
      messages.clear();
      for (const message of item.$set.messages) if (message?.id) messages.set(String(message.id), message);
      return "replace";
    }
    const rewindId = item?.$rewindTo?.id ?? item?.$rewindTo;
    if (rewindId) {
      let remove = false;
      for (const id of [...messages.keys()]) {
        if (id === String(rewindId)) remove = true;
        if (remove) messages.delete(id);
      }
      return "replace";
    }
    if ((item?.type === "user" || item?.type === "gemini") && item.id) {
      const id = String(item.id);
      const operation = messages.has(id) ? "replace" : "append";
      messages.set(id, item);
      return operation;
    }
    return null;
  }
  return { apply, getMessages: () => [...messages.values()] };
}

function materializeGeminiMessages(records) {
  const state = createGeminiMessageState();
  for (const item of records) state.apply(item);
  return state.getMessages();
}

module.exports = { createGeminiMessageState, materializeGeminiMessages };
